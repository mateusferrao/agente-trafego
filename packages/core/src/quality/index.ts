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
  /**
   * Há QUALQUER sinal de resultado na entidade: conversão de negócio > 0, OU uma
   * conversão-proxy (o objetivo próprio dela converte), OU atividade de funil
   * (conversas). Zumbi exige a AUSÊNCIA disso — evita marcar como desperdício uma
   * campanha cuja conversão de negócio não é rastreável ali mas que gera conversas
   * baratas (o caso do ICP: meta = venda, mas o ad entrega conversa).
   */
  readonly hasSignOfLife: boolean;
  /** entidade nova / em aprendizado — não declara zumbi antes de dar tempo. */
  readonly inLearning: boolean;
}

/**
 * Classe de desempenho. Zombie SÓ quando NÃO há nenhum sinal de resultado
 * (`!hasSignOfLife`) com gasto relevante e fora de learning — nunca marca como
 * desperdício quem gera conversas/proxy só porque a conversão de NEGÓCIO não é
 * rastreável ali. Sem significância (e não-zombie) → sem tier. Winner é checado
 * ANTES de underperformer: quem bate a meta não vira underperformer só por ter
 * piorado vs o próprio baseline.
 */
export function classifyTier(input: TierInput, t: QualityThresholds): PerformanceTier | undefined {
  if (!input.hasSignOfLife && !input.inLearning && input.spend >= t.zombieMinSpend) return "zombie";
  if (!input.hasSignificance) return undefined;
  if (input.beatsTarget || input.topEfficiencyNoTarget) return "winner";
  if (input.belowTarget || input.worseThanBaseline) return "underperformer";
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
  // top-quartil de eficiência (menor CPA) dentro do nível. SÓ CPA (mesma base) —
  // misturar CPA (custo-por-conversão) com CPC (custo-por-clique) no mesmo pool
  // compararia maçã com laranja. Sem CPA no nível → ninguém é winner por eficiência.
  const cpaCosts = summaries
    .map((e) => (typeof e.metrics.cpa === "number" && e.metrics.cpa > 0 ? e.metrics.cpa : undefined))
    .filter((c): c is number => typeof c === "number")
    .sort((a, b) => a - b);
  const q1 = cpaCosts.length > 0 ? cpaCosts[Math.floor((cpaCosts.length - 1) * 0.25)]! : Infinity;

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

    // eficiência só vale p/ quem tem CPA (mesma base do pool q1).
    const cpa = typeof e.metrics.cpa === "number" && e.metrics.cpa > 0 ? e.metrics.cpa : undefined;
    // sinal de vida: conversão de negócio, OU conversão-proxy (objetivo próprio), OU
    // conversas no funil. Ausência total (com gasto, fora de learning) = zumbi.
    const conversationStarted = e.funnel?.counts?.conversation_started ?? 0;
    const hasSignOfLife = conversions > 0 || typeof e.proxy?.cpa === "number" || conversationStarted > 0;
    const tier = classifyTier(
      {
        conversions,
        spend: e.metrics.spend,
        hasSignificance: eligibility.hasSignificance,
        beatsTarget: beatsTargetFor(e, goals),
        belowTarget: e.flags.some((f) => BELOW_TARGET_FLAGS.has(f)),
        worseThanBaseline: costRisePct >= t.fatigueCostRisePct,
        topEfficiencyNoTarget: !ctx.hasTarget && cpa !== undefined && cpa <= q1,
        hasSignOfLife,
        inLearning: eligibility.inLearning,
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
