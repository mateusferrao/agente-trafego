// Qualidade da análise (Fatia 6c) — PURO. Camada determinística sobre o dado já
// curado do brief: elegibilidade de decisão (significância/learning), sinais de
// saúde (fadiga/saturação/baixo volume) e tiers (winner/performer/underperformer/
// zombie). NÃO declara sucesso de negócio — só a meta do dono faz isso; isto é
// ranqueamento relativo + rede de segurança que alimenta prompt, guard e UI.

import type {
  ConversionGoal,
  DecisionEligibility,
  EntitySummary,
  HealthSignal,
  InsightMetrics,
  PerformanceTier,
} from "@trafego/shared";
import { type CostReferenceBand, type OutcomeKind, benchmarkFor } from "../benchmarks/index.js";

/** Limiares (defaults do squad; overridáveis por env/por-agente). */
export interface QualityThresholds {
  /** significância: mín. conversões de negócio na janela. */
  readonly minConversions: number;
  /** significância: mín. cliques na janela (alternativa às conversões). */
  readonly minClicks: number;
  /** fadiga: queda relativa de CTR (%) semana/semana. */
  readonly fatigueCtrDropPct: number;
  /** fadiga/saturação: frequência acima disso é sinal. */
  readonly fatigueFrequency: number;
  /** fadiga: alta do custo-por-resultado (%) vs baseline. */
  readonly fatigueCostRisePct: number;
  /** zombie: gasto mínimo na janela p/ considerar desperdício (moeda da conta). */
  readonly zombieMinSpend: number;
  /** mostrar a referência de plataforma no cold-start (sem meta E sem histórico). */
  readonly coldStartReference: boolean;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minConversions: 20,
  minClicks: 100,
  fatigueCtrDropPct: 20,
  fatigueFrequency: 3,
  fatigueCostRisePct: 30,
  zombieMinSpend: 50,
  coldStartReference: true,
};

// ─── Elegibilidade de decisão ─────────────────────────────────────────────
export interface EligibilityInput {
  readonly conversions: number;
  readonly clicks: number;
  /**
   * A entidade existia (com dado) na janela anterior. Proxy determinístico p/
   * "rodando há ≥ janela" (não é nova) — evita depender de created/updated_time
   * que hoje não sincronizamos. Entidade sem baseline = nova ⇒ em learning.
   */
  readonly hasBaseline: boolean;
}

/**
 * Elegibilidade de DECISÃO. Significância = volume suficiente (conversões OU
 * cliques) E já rodava na janela anterior (`hasBaseline`, proxy de ≥7 dias).
 * Learning ≈ entidade nova (sem baseline) → Meta ainda re-otimizando.
 */
export function computeEligibility(input: EligibilityInput, t: QualityThresholds): DecisionEligibility {
  const enoughVolume = input.conversions >= t.minConversions || input.clicks >= t.minClicks;
  return {
    hasSignificance: enoughVolume && input.hasBaseline,
    inLearning: !input.hasBaseline,
    conversions: input.conversions,
    clicks: input.clicks,
  };
}

// ─── Sinais de saúde ──────────────────────────────────────────────────────
export interface HealthInput {
  readonly frequency?: number;
  /** queda relativa de CTR (%) vs baseline (positivo = caiu). */
  readonly ctrDropPct: number;
  /** alta relativa do custo-por-resultado (%) vs baseline (positivo = subiu). */
  readonly costRisePct: number;
  /** elegibilidade (p/ o sinal `low_volume`). */
  readonly hasSignificance: boolean;
}

/**
 * Sinais nomeados: fadiga (2+ de {CTR caiu, freq alta, custo subiu}), saturação
 * de público (freq alta isolada) e baixo volume (sem significância).
 */
export function detectHealthSignals(input: HealthInput, t: QualityThresholds): HealthSignal[] {
  const signals: HealthSignal[] = [];
  const freqHigh = input.frequency !== undefined && input.frequency > t.fatigueFrequency;
  const fatigueHits =
    (input.ctrDropPct >= t.fatigueCtrDropPct ? 1 : 0) +
    (freqHigh ? 1 : 0) +
    (input.costRisePct >= t.fatigueCostRisePct ? 1 : 0);
  if (fatigueHits >= 2) signals.push("creative_fatigue");
  if (freqHigh) signals.push("audience_saturation");
  if (!input.hasSignificance) signals.push("low_volume");
  return signals;
}

// ─── Tiers ────────────────────────────────────────────────────────────────
export interface TierInput {
  readonly conversions: number;
  readonly spend: number;
  readonly hasSignificance: boolean;
  readonly beatsTarget: boolean;
  readonly belowTarget: boolean;
  readonly worseThanBaseline: boolean;
  /** sem meta definida E entre os mais eficientes da conta (top-quartil). */
  readonly topEfficiencyNoTarget: boolean;
}

/**
 * Classe de desempenho. Zombie independe de significância (gasto + 0 conversão JÁ
 * é o sinal). Sem significância (e não-zombie) → sem tier (não dá p/ julgar).
 */
export function classifyTier(input: TierInput, t: QualityThresholds): PerformanceTier | undefined {
  if (input.conversions === 0 && input.spend >= t.zombieMinSpend) return "zombie";
  if (!input.hasSignificance) return undefined;
  if (input.belowTarget || input.worseThanBaseline) return "underperformer";
  if (input.beatsTarget || input.topEfficiencyNoTarget) return "winner";
  return "performer";
}

// ─── Orquestrador: enriquece as EntitySummary de um nível ─────────────────
export interface EnrichQualityContext {
  readonly thresholds: QualityThresholds;
  /** meta do dono definida? (se não, winner pode vir por top-eficiência). */
  readonly hasTarget: boolean;
  /** moeda da conta (rótulo da faixa de referência). */
  readonly currency: string;
  /** conversão de negócio do agente (define a faixa de custo de cold-start). */
  readonly conversionGoal?: ConversionGoal;
  /** tabela de faixas de cold-start (override; senão default do sistema). */
  readonly costTable?: Readonly<Record<OutcomeKind, CostReferenceBand>>;
}

/** Custo-por-resultado da entidade (CPA quando há; senão CPC) — p/ eficiência. */
function costPerResult(m: InsightMetrics): number | undefined {
  if (typeof m.cpa === "number" && m.cpa > 0) return m.cpa;
  if (typeof m.cpc === "number" && m.cpc > 0) return m.cpc;
  return undefined;
}

/** Queda relativa (%) de uma métrica "maior = melhor" (CTR): baseline→atual. */
function dropPct(current: number | undefined, deltaAbs: number | undefined): number {
  if (typeof current !== "number" || typeof deltaAbs !== "number") return 0;
  const baseline = current - deltaAbs;
  return baseline > 0 ? ((baseline - current) / baseline) * 100 : 0;
}

/** Alta relativa (%) de uma métrica "menor = melhor" (custo): baseline→atual. */
function risePct(current: number | undefined, deltaAbs: number | undefined): number {
  if (typeof current !== "number" || typeof deltaAbs !== "number") return 0;
  const baseline = current - deltaAbs;
  return baseline > 0 ? ((current - baseline) / baseline) * 100 : 0;
}

function beatsTargetFor(e: EntitySummary, goals: { targetCPA?: number; targetROAS?: number }): boolean {
  if (e.conversionBasis !== "target") return false;
  const cpaOk = goals.targetCPA !== undefined && typeof e.metrics.cpa === "number" && e.metrics.cpa <= goals.targetCPA;
  const roasOk =
    goals.targetROAS !== undefined && typeof e.metrics.roas === "number" && e.metrics.roas >= goals.targetROAS;
  return cpaOk || roasOk;
}

const BELOW_TARGET_FLAGS = new Set(["cpa_acima_da_meta", "roas_abaixo_da_meta"]);

/**
 * Enriquece as summaries de UM nível com eligibility, healthSignals e tier. As
 * comparações relativas (queda de CTR, alta de custo, eficiência) usam o próprio
 * dado da entidade + o ranking dentro do nível — nada externo à conta.
 */
export function enrichEntitiesQuality(
  summaries: readonly EntitySummary[],
  goals: { targetCPA?: number; targetROAS?: number },
  ctx: EnrichQualityContext,
): EntitySummary[] {
  const t = ctx.thresholds;
  // top-quartil de eficiência (menor custo-por-resultado) dentro do nível.
  const costs = summaries
    .map((e) => costPerResult(e.metrics))
    .filter((c): c is number => typeof c === "number")
    .sort((a, b) => a - b);
  const q1 = costs.length > 0 ? costs[Math.floor((costs.length - 1) * 0.25)]! : Infinity;

  return summaries.map((e) => {
    const conversions = typeof e.metrics.conversions === "number" ? e.metrics.conversions : 0;
    const clicks = e.metrics.clicks;
    const hasBaseline = Object.keys(e.deltaVsBaseline).length > 0;
    const eligibility = computeEligibility({ conversions, clicks, hasBaseline }, t);

    const ctrDropPct = dropPct(e.metrics.ctr, e.deltaVsBaseline.ctr);
    const costMetric = typeof e.metrics.cpa === "number" ? "cpa" : "cpc";
    const costRisePct = risePct(e.metrics[costMetric], e.deltaVsBaseline[costMetric]);
    const healthSignals = detectHealthSignals(
      { ...(e.metrics.frequency !== undefined ? { frequency: e.metrics.frequency } : {}), ctrDropPct, costRisePct, hasSignificance: eligibility.hasSignificance },
      t,
    );

    const cost = costPerResult(e.metrics);
    const tier = classifyTier(
      {
        conversions,
        spend: e.metrics.spend,
        hasSignificance: eligibility.hasSignificance,
        beatsTarget: beatsTargetFor(e, goals),
        belowTarget: e.flags.some((f) => BELOW_TARGET_FLAGS.has(f)),
        worseThanBaseline: costRisePct >= t.fatigueCostRisePct,
        topEfficiencyNoTarget: !ctx.hasTarget && cost !== undefined && cost <= q1,
      },
      t,
    );

    // Cold-start = sem meta E sem histórico da entidade → única hora em que a
    // referência de plataforma entra (rotulada, nunca meta). Toggle por-agente.
    const coldStart = t.coldStartReference && !ctx.hasTarget && !hasBaseline;
    const outcomeGoal = ctx.conversionGoal ?? e.objective?.goal;
    const benchmarkRef = coldStart
      ? benchmarkFor({
          ctr: e.metrics.ctr,
          ...(e.metrics.frequency !== undefined ? { frequency: e.metrics.frequency } : {}),
          ...(outcomeGoal ? { outcomeGoal } : {}),
          currency: ctx.currency,
          coldStart: true,
          ...(ctx.costTable ? { costTable: ctx.costTable } : {}),
        })
      : undefined;

    return {
      ...e,
      eligibility,
      ...(healthSignals.length > 0 ? { healthSignals } : {}),
      ...(tier ? { tier } : {}),
      ...(benchmarkRef ? { benchmarkRef } : {}),
    };
  });
}
