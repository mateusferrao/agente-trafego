// Config resolvida do pipeline de análise (§ princípio-guia: por-agente já no dado).
// Precedência: agents.model_config (jsonb) → fallback nos defaults globais (env).
// PURO — a Fatia 4 só pluga a UI de edição do model_config; nada muda aqui.

/** Estratégias de execução (quais unidades reanalisar por run) — enum neutro, aberto. */
export type ExecutionPolicy = "deep_periodic_incremental" | "full_every_run" | "budget_scaled";

/** Esforço de reasoning dos passos de LLM (`off` desliga). */
export type ReasoningEffort = "off" | "low" | "medium" | "high";
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "low", "medium", "high"];

const EXECUTION_POLICIES: readonly ExecutionPolicy[] = [
  "deep_periodic_incremental",
  "full_every_run",
  "budget_scaled",
];

/**
 * Limites da janela de análise por-agente (Fatia 4). Teto 30d: com o baseline
 * espelhando a janela, janela+baseline = 60d < retenção (~90d) e sem estourar o
 * custo/contexto (trends = 1 ponto/dia; downsample p/ 90d = roadmap).
 */
export const ANALYSIS_WINDOW_MIN_DAYS = 1;
export const ANALYSIS_WINDOW_MAX_DAYS = 30;

export interface AnalysisDefaults {
  /** modelo FORTE — síntese da conta + reviewer (raciocínio cross-entidade). */
  readonly model: string;
  /** modelo BARATO por-anúncio (mapa) + visão. */
  readonly unitModel: string;
  /** modelo BARATO do redator do WhatsApp. */
  readonly messageModel: string;
  /** modelo multimodal (visão de criativo). */
  readonly visionModel: string;
  readonly reviewEnabled: boolean;
  readonly topN: number;
  readonly maxOutputTokens: number;
  /** esforço de reasoning nos passos de LLM (unit/síntese/revisão). */
  readonly reasoningEffort: ReasoningEffort;
  readonly maxCreativesVision: number;
  /** anúncios detalhados por campanha na árvore curada (resto vira cauda agregada). */
  readonly notableAdsPerCampaign: number;
  /** teto de criativos com visão POR campanha (prioriza maior gasto/flag). */
  readonly maxCreativesVisionPerCampaign: number;
  /** quantas campanhas o mapa analisa em paralelo (pool bounded). */
  readonly mapConcurrency: number;
  readonly windowDays: number;
  readonly baselineDays: number;
  readonly executionPolicy: ExecutionPolicy;
  readonly deepIntervalDays: number;
  readonly materialChangePct: number;
}

export type ResolvedAnalysisConfig = AnalysisDefaults;

export function resolveAnalysisConfig(
  modelConfig: Readonly<Record<string, unknown>> | null | undefined,
  defaults: AnalysisDefaults,
): ResolvedAnalysisConfig {
  const mc = modelConfig ?? {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const posInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  const nonNeg = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const policy = (v: unknown): ExecutionPolicy | undefined =>
    typeof v === "string" && (EXECUTION_POLICIES as readonly string[]).includes(v)
      ? (v as ExecutionPolicy)
      : undefined;
  const effort = (v: unknown): ReasoningEffort | undefined =>
    typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v)
      ? (v as ReasoningEffort)
      : undefined;
  // janela por-agente (um controle): quando definida, o baseline ESPELHA a janela.
  const overrideWindow = ((): number | undefined => {
    const n = posInt(mc.windowDays);
    return n === undefined
      ? undefined
      : Math.min(ANALYSIS_WINDOW_MAX_DAYS, Math.max(ANALYSIS_WINDOW_MIN_DAYS, n));
  })();

  return {
    model: str(mc.model) ?? defaults.model,
    unitModel: str(mc.unitModel) ?? defaults.unitModel,
    messageModel: str(mc.messageModel) ?? defaults.messageModel,
    visionModel: str(mc.visionModel) ?? defaults.visionModel,
    reviewEnabled: typeof mc.reviewEnabled === "boolean" ? mc.reviewEnabled : defaults.reviewEnabled,
    topN: posInt(mc.topN) ?? defaults.topN,
    maxOutputTokens: posInt(mc.maxOutputTokens) ?? defaults.maxOutputTokens,
    reasoningEffort: effort(mc.reasoningEffort) ?? defaults.reasoningEffort,
    maxCreativesVision: nonNeg(mc.maxCreativesVision) ?? defaults.maxCreativesVision,
    notableAdsPerCampaign: posInt(mc.notableAdsPerCampaign) ?? defaults.notableAdsPerCampaign,
    maxCreativesVisionPerCampaign:
      nonNeg(mc.maxCreativesVisionPerCampaign) ?? defaults.maxCreativesVisionPerCampaign,
    mapConcurrency: posInt(mc.mapConcurrency) ?? defaults.mapConcurrency,
    windowDays: overrideWindow ?? defaults.windowDays,
    baselineDays: overrideWindow ?? defaults.baselineDays, // espelha a janela quando há override
    executionPolicy: policy(mc.executionPolicy) ?? defaults.executionPolicy,
    deepIntervalDays: posInt(mc.deepIntervalDays) ?? defaults.deepIntervalDays,
    materialChangePct: nonNeg(mc.materialChangePct) ?? defaults.materialChangePct,
  };
}
