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
];

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

  const requested = edit.budgetMinor ?? spec.dailyBudgetMinor;
  const { dailyBudgetMinor, clampedByCap } = clampBudget(requested, ctx.budgetCapMinor);

  // Descarta um `requestedDailyBudgetMinor` de um clamp ANTERIOR: se esta edição não clampa, o
  // campo obsoleto faria o card mostrar um "reduzido de" falso. Só re-adiciona quando clampou agora.
  // C2: `adsets` sai do base pra ser recomposto abaixo (substituição total; lista vazia = limpa).
  const { requestedDailyBudgetMinor: _staleRequested, adsets: baseAdsets, ...base } = spec;
  // conjuntos resultantes: não editou → mantém; editou com lista → substitui; editou vazio → limpa.
  const nextAdsets = edit.adsets !== undefined ? (edit.adsets.length > 0 ? edit.adsets : undefined) : baseAdsets;

  const next: CampaignDraftSpec = {
    ...base,
    dailyBudgetMinor,
    ...(clampedByCap ? { requestedDailyBudgetMinor: requested } : {}),
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

  // GATE ÚNICO de destino (§7): objetivo de conversas no WhatsApp leva pro WhatsApp, não pra um site
  // → o link nunca vai pro anúncio. Cobre também o flip de objetivo PÓS-criação (site/chat trocam só
  // o objetivo mantendo um link antigo) — as bordas barram link NOVO; aqui limpa o link OBSOLETO.
  if (next.linkUrl !== undefined && isMessagingGoal(next.objective)) {
    const { linkUrl: _dropped, ...withoutLink } = next;
    return ok({ spec: withoutLink, clampedByCap });
  }

  return ok({ spec: next, clampedByCap });
}
