import {
  type AdsetSpec,
  type BudgetMode,
  type CampaignDraftSpec,
  type ConversionGoal,
  type CopyVariant,
  type CreativeAssetRef,
  type DraftKind,
  type Result,
  type TargetingSpec,
  err,
  ok,
} from "@trafego/shared";
import { isMessagingGoal } from "../conversion/index.js";

/**
 * Conversões que exigem PIXEL/rastreamento p/ serem otimizáveis. Fato de DOMÍNIO (neutro): o
 * adapter Meta realiza como `promoted_object` no adset (`resolveAdSetConversion`); aqui é a
 * verdade genérica usada pelo guard de edição de objetivo. `messaging_started`/`app_install`
 * otimizam por eventos que não dependem de pixel no site.
 */
export const REQUIRES_PIXEL: ReadonlySet<ConversionGoal> = new Set<ConversionGoal>([
  "purchase",
  "lead",
  "registration",
  "initiate_checkout",
  "add_to_cart",
  "view_content",
  "add_payment_info",
  "search",
  "contact",
  "subscribe",
  "start_trial",
  "submit_application",
  "custom",
]);

export const conversionRequiresPixel = (goal: ConversionGoal): boolean => REQUIRES_PIXEL.has(goal);

/** O que falta no `promoted_object` do conjunto pra este objetivo poder nascer — `"pixel"`, `"page"`
 *  ou `null` (nada falta). Insumos de conta/rascunho, não vocabulário Meta. */
export type PromotedObjectGap = "pixel" | "page" | null;

/**
 * Requisito de `promoted_object` CIENTE DO MECANISMO (fonte única, subsume a antiga `copyRequiresDestinationPage`).
 * Fato de DOMÍNIO (neutro; o adapter realiza como `promoted_object`, `resolveAdSetConversion`):
 * - **conversas** (`messaging_started`) → exige a **Página** (o clique leva pro WhatsApp dela) — sem pixel.
 * - **lead** tem 2 mecanismos: **site** (pixel → OFFSITE) e **formulário** (Página → LEAD_GENERATION, sem
 *   pixel). O formulário só é viável REUSANDO o criativo (o form vem pelo `creative_id`) — criar do zero não
 *   gera formulário. Então: tem pixel → ok (site); senão, reusa criativo E tem Página → ok (formulário);
 *   senão falta — na cópia falta a **Página** (a base era formulário e não a li), na criação falta o **pixel**
 *   (não dá pra gerar formulário do zero).
 * - **demais objetivos de conversão** (`REQUIRES_PIXEL`) → exigem **pixel**.
 * - **app/tráfego** → nada.
 * PURO. `reusesCreatives` = o spec reusa `creative_id` da base (cópia fiel); `hasPixel`/`hasPage` = a conta/
 * fonte tem cada um resolvido.
 */
export function promotedObjectGap(
  goal: ConversionGoal,
  ctx: { readonly reusesCreatives: boolean; readonly hasPixel: boolean; readonly hasPage: boolean },
): PromotedObjectGap {
  if (isMessagingGoal(goal)) return ctx.hasPage ? null : "page";
  if (goal === "lead") {
    if (ctx.hasPixel) return null; // mecanismo de site (OFFSITE)
    if (ctx.reusesCreatives && ctx.hasPage) return null; // mecanismo de formulário (reuso do creative_id)
    return ctx.reusesCreatives ? "page" : "pixel"; // cópia de formulário sem Página lida × criação sem pixel
  }
  if (conversionRequiresPixel(goal)) return ctx.hasPixel ? null : "pixel";
  return null; // app_install / tráfego — sem requisito de promoted_object
}

/**
 * Faixa de idade que a Meta HONRA como restrição DURA sob otimização automática (advantage_audience):
 * só dentro de 18-25. Um piso acima disso (ex: 45+), ou qualquer teto acima disso, a Meta RECUSA como
 * trava — aceita a idade só como "sugestão" (outro mecanismo). Fato de PLATAFORMA confirmado em produção
 * (age_min:45 + advantage_audience:1 → "Invalid parameter" / "adicione uma idade mínima maior como
 * sugestão"). Neutro (número de política, não vocabulário de provider).
 */
export const ADVANTAGE_HARD_AGE_MAX = 25;

/**
 * A idade EXPLÍCITA do conjunto conflita com a otimização automática? `true` quando ela está ligada E
 * há um piso OU teto de idade acima da faixa 18-25 que a Meta trava (§7/§8: a resolução é do DONO —
 * travar a idade com a otimização desligada, OU manter a otimização e deixar a idade livre; nunca
 * decide sozinho). PURO — fonte única do gate (propose no chat + rede do apply).
 */
export function advantageAgeConflict(spec: Pick<CampaignDraftSpec, "targeting" | "adsets">, advantageOn: boolean): boolean {
  if (!advantageOn) return false;
  const conflicts = (t?: TargetingSpec): boolean =>
    t?.kind === "explicit" &&
    ((t.ageMin !== undefined && t.ageMin > ADVANTAGE_HARD_AGE_MAX) || (t.ageMax !== undefined && t.ageMax > ADVANTAGE_HARD_AGE_MAX));
  return conflicts(spec.targeting) || (spec.adsets ?? []).some((a) => conflicts(a.targeting));
}

/**
 * URL de destino informada pelo dono → normalizada (http/https absoluto) ou `null` se não for uma
 * URL válida. Aceita "loja.com" (prefixa https://) e REJEITA esquema não-http(s) (`javascript:`,
 * `data:`, `ftp:`) e host sem ponto. Fonte ÚNICA (§13) do chat E do site — a Meta exige link
 * absoluto no `link_data.link`. PURO.
 */
export function normalizeLinkUrl(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  if (s.length === 0) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    // só http/https (bloqueia javascript:/data:/ftp: mesmo que new URL aceite) + host com ponto.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Motivo amigável ÚNICO (§13) quando o objetivo escolhido exige pixel e a conta não tem — reusado
 * no refino (chat), na criação do zero (chat + rede do apply) e no site. Erro = o quê + próximo
 * passo, com a alternativa nativa do produto (mensagens no WhatsApp não precisa de pixel).
 */
export const OBJECTIVE_REQUIRES_PIXEL_REASON =
  "esse objetivo precisa do rastreamento de conversões (pixel) configurado na conta, e ela ainda não tem — dá pra configurar o pixel no Gerenciador de Eventos da Meta, ou eu crio uma campanha de mensagens no WhatsApp (que não precisa de pixel)";

/**
 * Motivo NEUTRO (§13) da rede do apply quando o objetivo exige uma Página de destino (conversas → WhatsApp
 * da Página; formulário de lead → formulário da Página) e o rascunho não tem uma resolvida. Genérico (o
 * chat tem versões mais específicas por caminho — cópia/criação); aqui é a última rede antes de criar.
 */
export const OBJECTIVE_REQUIRES_PAGE_REASON =
  "essa campanha precisa de uma Página de destino (é pra onde as conversas/leads vão) e eu não consegui identificar uma agora — tenta de novo em instantes, ou crie pela análise/site (lá dá pra escolher a Página)";

/**
 * Motivo/pergunta ÚNICO (§13/§8) quando a idade fixa colide com a otimização automática — o dono
 * DECIDE (nunca o Roy). Erro = o quê + as duas saídas concretas. Reusado na rede do apply e no chat.
 */
export const ADVANTAGE_AGE_CONFLICT_REASON =
  "você escolheu uma faixa de idade fixa, mas a otimização automática de público não trava a idade na Meta — as duas não vão juntas. Como você prefere? Me diga: *travar a idade* (desligo a otimização e mantenho a sua faixa) ou *tirar a faixa de idade* (mantenho a otimização e deixo o público livre pra ela otimizar)";

/** Patch NEUTRO de edição — campos já RESOLVIDOS pela casca (audience→targeting, asset/serving→
 *  creative, geração/add/remover→copyVariants). O núcleo só faz o merge + as regras de negócio. */
export interface DraftEdit {
  readonly budgetMinor?: number;
  readonly activation?: "active" | "paused";
  // ─── só from_scratch ───
  readonly campaignName?: string;
  readonly adsetName?: string;
  readonly objective?: ConversionGoal;
  /** pixel resolvido DA CONTA (setado junto com `objective` quando o novo objetivo precisa dele —
   *  o apply deriva o `promoted_object` disso). Não é campo direto do usuário. */
  readonly pixelId?: string;
  readonly targeting?: TargetingSpec;
  /** Conjuntos do teste multi-conjunto (C2) — SUBSTITUIÇÃO TOTAL (o site manda a lista completa,
   *  já resolvida). Vazio/1 = volta a single-conjunto. A casca converte público explícito →
   *  TargetingSpec + orçamento → dailyBudgetMinor antes de passar. */
  readonly adsets?: readonly AdsetSpec[];
  /** Onde a verba mora (P2 — a conversão single→multi de um teste de público nasce CBO: verba única
   *  na campanha, dividida entre os conjuntos). Só faz sentido junto com `adsets`. */
  readonly budgetMode?: BudgetMode;
  /** Advantage+ audience (F1a — editável no rascunho pendente): true = a Meta EXPANDE além do público
   *  escolhido; false grava explícito (desliga). Ausente = não mexe. O eco AVISA quando liga. */
  readonly advantageAudience?: boolean;
  /** Advantage+ creative enhancements (F1a): true = a Meta pode ajustar imagem/texto/CTA. O eco AVISA. */
  readonly advantageCreative?: boolean;
  readonly creative?: CreativeAssetRef;
  readonly copyVariants?: readonly CopyVariant[];
  /** PÁGINA de destino (object_story_spec) resolvida pela casca a partir do nome/número dito pelo dono
   *  (W2 — trocar a Página quando há N). Em campanha de conversas define pra qual WhatsApp o clique leva. */
  readonly pageId?: string;
  /** URL de destino do anúncio (link_data.link) — informada pelo dono (chat/site), vence a herdada
   *  da conta. Só faz sentido em objetivo de site/tráfego/conversão; a casca já filtra em
   *  `messaging_started` (leva pro WhatsApp). `""` (string vazia) NÃO chega aqui — a casca omite. */
  readonly linkUrl?: string;
  /** Resolução DETERMINÍSTICA do conflito idade×otimização (B4, §8 o dono decide): `lock_age` desliga a
   *  otimização e mantém a faixa; `drop_age` mantém a otimização e REMOVE a idade dura de TODOS os
   *  conjuntos. Ausente = não mexe. Fecha o buraco do "tirar a faixa" (o LLM não tinha como limpar idade). */
  readonly resolveAgeConflict?: "lock_age" | "drop_age";
  // ─── só duplicate ───
  readonly suffixLabel?: string;
}

export interface DraftEditContext {
  /** teto de gasto novo (unidade mínima) — clamp; null/undefined = sem teto. */
  readonly budgetCapMinor?: number | null;
  /** a conta tem pixel? (re-resolvido DA CONTA, não de `spec.pixelId`). */
  readonly hasPixel: boolean;
}

export type RefineError =
  | { readonly code: "field_not_editable"; readonly field: string }
  | { readonly code: "objective_requires_pixel"; readonly objective: ConversionGoal }
  | { readonly code: "empty_variants" };

export interface DraftEditResult {
  readonly spec: CampaignDraftSpec;
  readonly clampedByCap: boolean;
}

/** Campos de edição exclusivos de `from_scratch` (herdados no `duplicate`, não editáveis lá). */
const FROM_SCRATCH_ONLY: readonly (keyof DraftEdit)[] = [
  "campaignName",
  "adsetName",
  "objective",
  "pixelId",
  "targeting",
  "adsets",
  "budgetMode",
  "advantageAudience",
  "advantageCreative",
  "creative",
  "copyVariants",
  "linkUrl",
  "pageId",
  "resolveAgeConflict",
];

/** Remove a idade dura (ageMin/ageMax) de um targeting explícito; mantém geo/gênero/interesses.
 *  Não-explícito passa direto. PURO — usado na resolução `drop_age` do conflito idade×otimização. */
function stripExplicitAge(t: TargetingSpec): TargetingSpec {
  if (t.kind !== "explicit") return t;
  const { ageMin: _min, ageMax: _max, ...rest } = t;
  return rest;
}

function clampBudget(requestedMinor: number, capMinor: number | null | undefined): { dailyBudgetMinor: number; clampedByCap: boolean } {
  const dailyBudgetMinor = capMinor != null ? Math.min(requestedMinor, capMinor) : requestedMinor;
  return { dailyBudgetMinor, clampedByCap: dailyBudgetMinor < requestedMinor };
}

/**
 * Merge PURO do rascunho (Fatia 7 — edição). Fonte única do refino, consumida por chat e site.
 * `kind` vem da linha `campaign_drafts` (o spec não carrega). IO (targeting/creative/copy/pixel)
 * já resolvida na casca. Retorna erro TIPADO (§13) — a casca traduz p/ mensagem amigável.
 */
/**
 * Remove conjuntos por índice (P2 — paridade com remover anúncio no chat). Índices fora da faixa ou
 * repetidos são ignorados; a ordem dos restantes é preservada. PURO — a casca resolve o público dos
 * conjuntos que ADICIONA; a remoção é pura manipulação da lista.
 */
export function removeAdsetsAt(adsets: readonly AdsetSpec[], indices: readonly number[]): readonly AdsetSpec[] {
  const drop = new Set(indices);
  return adsets.filter((_, i) => !drop.has(i));
}

/**
 * Semeia o 1º conjunto de um teste multi-conjunto a partir de um rascunho de 1 conjunto (P2 —
 * "adiciona um conjunto" converte o público ATUAL no conjunto 1, e os novos entram como 2, 3…). PURO:
 * leva o nome + o público atuais; público ausente/amplo → `advantage_plus` explícito (honesto). O
 * orçamento não vai pro conjunto aqui — o teste de público nasce CBO (verba única na campanha).
 */
export function seedAdsetFromSingle(spec: Pick<CampaignDraftSpec, "adsetName" | "targeting">): AdsetSpec {
  return {
    ...(spec.adsetName ? { name: spec.adsetName } : {}),
    targeting: spec.targeting ?? { kind: "advantage_plus" },
  };
}

/**
 * Verba por nível ao criar/trocar CBO↔ABO num teste multi-conjunto (F1b/F1c) — regra de NEGÓCIO pura.
 * Semântica ABO da Meta (e do piso, `resolveBudgetFloorMinor`): o diário é POR CONJUNTO, não um total
 * dividido. Por isso:
 * - **→ ABO** (verba por conjunto): cada conjunto ganha o PRÓPRIO diário — preserva o que já tinha,
 *   senão herda o diário da campanha (evita o gasto N× do fallback CHEIO do apply; o dono ajusta cada
 *   um). Num flip vindo de CBO o gasto TOTAL passa a ser ~N× — a casca AVISA honesto no eco.
 * - **→ CBO** (verba única na campanha): SOMA os diários dos conjuntos na campanha (preserva o gasto)
 *   e LIMPA o per-conjunto; sem diários por-conjunto → mantém o diário atual da campanha.
 * Retorna os conjuntos transformados + o diário resultante da campanha. PURO.
 */
export function flipBudgetLevel(
  adsets: readonly AdsetSpec[],
  toMode: BudgetMode,
  campaignDailyMinor: number,
): { adsets: readonly AdsetSpec[]; campaignDailyMinor: number } {
  if (toMode === "abo") {
    return {
      adsets: adsets.map((a) => ({ ...a, dailyBudgetMinor: a.dailyBudgetMinor ?? campaignDailyMinor })),
      campaignDailyMinor,
    };
  }
  const sum = adsets.reduce((acc, a) => acc + (a.dailyBudgetMinor ?? 0), 0);
  return {
    adsets: adsets.map(({ dailyBudgetMinor: _drop, ...rest }) => rest),
    campaignDailyMinor: sum > 0 ? sum : campaignDailyMinor,
  };
}

export function applyDraftEdit(
  kind: DraftKind,
  spec: CampaignDraftSpec,
  edit: DraftEdit,
  ctx: DraftEditContext,
): Result<DraftEditResult, RefineError> {
  // Escala (duplicate): só budget/ativação/suffixLabel. Campos herdados não são editáveis.
  if (kind === "duplicate") {
    const offending = FROM_SCRATCH_ONLY.find((f) => edit[f] !== undefined);
    if (offending) return err({ code: "field_not_editable", field: offending });
  }

  // Objetivo (from_scratch) que exige pixel sem pixel na conta → bloqueia cedo.
  if (edit.objective !== undefined && conversionRequiresPixel(edit.objective) && !ctx.hasPixel) {
    return err({ code: "objective_requires_pixel", objective: edit.objective });
  }

  // Copy: substituição completa (a casca já montou o array com add/remover/gerar). Mín 1 anúncio.
  if (edit.copyVariants !== undefined && edit.copyVariants.length === 0) {
    return err({ code: "empty_variants" });
  }

  // Descarta um `requestedDailyBudgetMinor` de um clamp ANTERIOR: se esta edição não clampa, o
  // campo obsoleto faria o card mostrar um "reduzido de" falso. Só re-adiciona quando clampou agora.
  // C2: `adsets` sai do base pra ser recomposto abaixo (substituição total; lista vazia = limpa).
  const { requestedDailyBudgetMinor: _staleRequested, adsets: baseAdsets, ...base } = spec;
  // conjuntos resultantes: não editou → mantém; editou com lista → substitui; editou vazio → limpa.
  let nextAdsets = edit.adsets !== undefined ? (edit.adsets.length > 0 ? edit.adsets : undefined) : baseAdsets;

  // F1b — flip de nível de orçamento (CBO↔ABO) num teste multi-conjunto move a verba de nível SEM o
  // dono perder/multiplicar gasto (ele só disse ONDE a verba mora): →ABO semeia o diário por conjunto
  // (evita o gasto N× do fallback do apply); →CBO consolida a soma na campanha e limpa o per-conjunto.
  // Base do diário da campanha = edição explícita do dono (vence) senão o diário atual.
  let campaignBasisMinor = edit.budgetMinor ?? spec.dailyBudgetMinor;
  if (edit.budgetMode !== undefined && edit.budgetMode !== (spec.budgetMode ?? "cbo") && nextAdsets !== undefined && nextAdsets.length >= 2) {
    const flip = flipBudgetLevel(nextAdsets, edit.budgetMode, campaignBasisMinor);
    // Teto de gasto novo POR conjunto (ABO): o apply usa o diário do conjunto DIRETO (não re-clampa) —
    // sem clampar cada um aqui, budget+flip juntos furariam o teto (guardrail independe da aprovação, §8).
    nextAdsets = flip.adsets.map((a) => (a.dailyBudgetMinor !== undefined ? { ...a, dailyBudgetMinor: clampBudget(a.dailyBudgetMinor, ctx.budgetCapMinor).dailyBudgetMinor } : a));
    if (edit.budgetMinor === undefined) campaignBasisMinor = flip.campaignDailyMinor; // →CBO consolida a soma
  }
  const { dailyBudgetMinor, clampedByCap } = clampBudget(campaignBasisMinor, ctx.budgetCapMinor);

  const next: CampaignDraftSpec = {
    ...base,
    dailyBudgetMinor,
    ...(clampedByCap ? { requestedDailyBudgetMinor: campaignBasisMinor } : {}),
    ...(edit.activation !== undefined ? { activation: edit.activation } : {}),
    ...(edit.suffixLabel !== undefined ? { suffixLabel: edit.suffixLabel } : {}),
    ...(edit.campaignName !== undefined ? { campaignName: edit.campaignName } : {}),
    ...(edit.adsetName !== undefined ? { adsetName: edit.adsetName } : {}),
    ...(edit.objective !== undefined ? { objective: edit.objective } : {}),
    ...(edit.pixelId !== undefined ? { pixelId: edit.pixelId } : {}),
    ...(edit.targeting !== undefined ? { targeting: edit.targeting } : {}),
    ...(nextAdsets ? { adsets: nextAdsets } : {}),
    ...(edit.budgetMode !== undefined ? { budgetMode: edit.budgetMode } : {}),
    ...(edit.advantageAudience !== undefined ? { advantageAudience: edit.advantageAudience } : {}),
    ...(edit.advantageCreative !== undefined ? { advantageCreative: edit.advantageCreative } : {}),
    ...(edit.creative !== undefined ? { creative: edit.creative } : {}),
    ...(edit.pageId !== undefined ? { pageId: edit.pageId } : {}),
    ...(edit.copyVariants !== undefined ? { copyVariants: edit.copyVariants, variantsCount: edit.copyVariants.length } : {}),
    ...(edit.linkUrl !== undefined ? { linkUrl: edit.linkUrl } : {}),
  };

  // B4: resolução DETERMINÍSTICA do conflito idade×otimização (o dono escolheu). `lock_age` desliga a
  // otimização e mantém a faixa; `drop_age` mantém a otimização e LIMPA a idade dura de TODOS os
  // conjuntos (single + adsets) — fecha o buraco em que o LLM não conseguia zerar a idade sozinho.
  const resolved: CampaignDraftSpec =
    edit.resolveAgeConflict === "lock_age"
      ? { ...next, advantageAudience: false, advantageCreative: false }
      : edit.resolveAgeConflict === "drop_age"
        ? {
            ...next,
            ...(next.targeting ? { targeting: stripExplicitAge(next.targeting) } : {}),
            ...(next.adsets ? { adsets: next.adsets.map((a) => (a.targeting ? { ...a, targeting: stripExplicitAge(a.targeting) } : a)) } : {}),
          }
        : next;

  // GATE ÚNICO de destino (§7): objetivo de conversas no WhatsApp leva pro WhatsApp, não pra um site
  // → o link nunca vai pro anúncio. Cobre também o flip de objetivo PÓS-criação (site/chat trocam só
  // o objetivo mantendo um link antigo) — as bordas barram link NOVO; aqui limpa o link OBSOLETO.
  if (resolved.linkUrl !== undefined && isMessagingGoal(resolved.objective)) {
    const { linkUrl: _dropped, ...withoutLink } = resolved;
    return ok({ spec: withoutLink, clampedByCap });
  }

  return ok({ spec: resolved, clampedByCap });
}
