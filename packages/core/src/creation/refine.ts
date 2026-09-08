import {
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
  readonly creative?: CreativeAssetRef;
  readonly copyVariants?: readonly CopyVariant[];
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
  "creative",
  "copyVariants",
  "linkUrl",
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
  const { requestedDailyBudgetMinor: _staleRequested, ...base } = spec;

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
    ...(edit.creative !== undefined ? { creative: edit.creative } : {}),
    ...(edit.copyVariants !== undefined ? { copyVariants: edit.copyVariants, variantsCount: edit.copyVariants.length } : {}),
    ...(edit.linkUrl !== undefined ? { linkUrl: edit.linkUrl } : {}),
  };

  return ok({ spec: next, clampedByCap });
}
