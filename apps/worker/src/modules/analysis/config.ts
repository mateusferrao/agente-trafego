// Config resolvida do pipeline de análise (§ princípio-guia: por-agente já no dado).
// Precedência: agents.model_config (jsonb) → fallback nos defaults globais (env).
// PURO — a Fatia 4 só pluga a UI de edição do model_config; nada muda aqui.
import { ANALYSIS_WINDOW_MIN_DAYS, ANALYSIS_WINDOW_MAX_DAYS } from "@trafego/shared";
import { DEFAULT_QUALITY_THRESHOLDS, type QualityThresholds } from "@trafego/core";

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
 * Limites da janela de análise por-agente (Fatia 4) — fonte única em @trafego/shared.
 * Reexportados aqui p/ o clamp local (`overrideWindow`) e consumidores do worker.
 */
export { ANALYSIS_WINDOW_MIN_DAYS, ANALYSIS_WINDOW_MAX_DAYS };

export interface AnalysisDefaults {
  /** modelo FORTE — síntese da conta (raciocínio cross-entidade; é a autoridade da análise). */
  readonly model: string;
  /** modelo do REVIEWER — refina/corta (nunca inventa); tarefa leve, barato e não-reasoning. */
  readonly reviewModel: string;
  /** modelo BARATO por-anúncio (mapa) + visão. */
  readonly unitModel: string;
  /** modelo(s) de RESERVA do unit — fallback com retry/backoff se o primário esgotar. */
  readonly unitFallbackModels: readonly string[];
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
  /** Limiares de qualidade (Fatia 6c) — significância/fadiga/zombie. */
  readonly quality: QualityThresholds;
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
    reviewModel: str(mc.reviewModel) ?? defaults.reviewModel,
    unitModel: str(mc.unitModel) ?? defaults.unitModel,
    unitFallbackModels: defaults.unitFallbackModels,
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
    quality: resolveQuality(mc.quality, defaults.quality),
  };
}

/** Override por-agente dos limiares de qualidade (objeto `quality` no model_config). */
function resolveQuality(raw: unknown, defaults: QualityThresholds | undefined): QualityThresholds {
  const d = defaults ?? DEFAULT_QUALITY_THRESHOLDS;
  const mc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const posInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  const nonNeg = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const stageCap = (raw && typeof raw === "object" ? (raw as Record<string, unknown>).frequencyCapByStage : undefined) as
    | Record<string, unknown>
    | undefined;
  return {
    minConversions: posInt(mc.minConversions) ?? d.minConversions,
    minClicks: posInt(mc.minClicks) ?? d.minClicks,
    fatigueCtrDropPct: nonNeg(mc.fatigueCtrDropPct) ?? d.fatigueCtrDropPct,
    fatigueFrequency: pos(mc.fatigueFrequency) ?? d.fatigueFrequency,
    frequencyCapByStage: {
      prospecting: pos(stageCap?.prospecting) ?? d.frequencyCapByStage.prospecting,
      remarketing: pos(stageCap?.remarketing) ?? d.frequencyCapByStage.remarketing,
    },
    fatigueCostRisePct: nonNeg(mc.fatigueCostRisePct) ?? d.fatigueCostRisePct,
    zombieMinSpend: nonNeg(mc.zombieMinSpend) ?? d.zombieMinSpend,
    coldStartReference: typeof mc.coldStartReference === "boolean" ? mc.coldStartReference : d.coldStartReference,
    trackingBrokenRatio: pos(mc.trackingBrokenRatio) ?? d.trackingBrokenRatio,
    trackingBrokenMinFunnel: nonNeg(mc.trackingBrokenMinFunnel) ?? d.trackingBrokenMinFunnel,
    relativeEligibilitySpendMultiplier: pos(mc.relativeEligibilitySpendMultiplier) ?? d.relativeEligibilitySpendMultiplier,
    marginalCpaWorsenPct: pos(mc.marginalCpaWorsenPct) ?? d.marginalCpaWorsenPct,
  };
}
