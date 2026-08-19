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
    windowDays: defaults.windowDays,
    baselineDays: defaults.baselineDays,
    executionPolicy: policy(mc.executionPolicy) ?? defaults.executionPolicy,
    deepIntervalDays: posInt(mc.deepIntervalDays) ?? defaults.deepIntervalDays,
    materialChangePct: nonNeg(mc.materialChangePct) ?? defaults.materialChangePct,
  };
}
