// Config resolvida do pipeline de análise (§ princípio-guia: por-agente já no dado).
// Precedência: agents.model_config (jsonb) → fallback nos defaults globais (env).
// PURO — a Fatia 4 só pluga a UI de edição do model_config; nada muda aqui.

export interface AnalysisDefaults {
  readonly model: string;
  readonly reviewEnabled: boolean;
  readonly topN: number;
  readonly maxOutputTokens: number;
  readonly windowDays: number;
  readonly baselineDays: number;
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
  return {
    model: str(mc.model) ?? defaults.model,
    reviewEnabled: typeof mc.reviewEnabled === "boolean" ? mc.reviewEnabled : defaults.reviewEnabled,
    topN: posInt(mc.topN) ?? defaults.topN,
    maxOutputTokens: posInt(mc.maxOutputTokens) ?? defaults.maxOutputTokens,
    windowDays: defaults.windowDays,
    baselineDays: defaults.baselineDays,
  };
}
