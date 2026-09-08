// Qualidade da análise (Fatia 6c) — PURO. Camada determinística sobre o dado já
// curado do brief: elegibilidade de decisão (significância/learning), sinais de
// saúde (fadiga/saturação/baixo volume) e tiers (winner/performer/underperformer/
// zombie). NÃO declara sucesso de negócio — só a meta do dono faz isso; isto é
// ranqueamento relativo + rede de segurança que alimenta prompt, guard e UI.

import type {
  AudienceStage,
  ConversionBasis,
  ConversionGoal,
  CreativeProofStrength,
  DecisionEligibility,
  EntitySummary,
  HealthSignal,
  InsightMetrics,
  OutcomeKind,
  PerformanceTier,
  PlatformQualityRankings,
  RangeBand,
} from "@trafego/shared";
import { type CtrBands, benchmarkFor } from "../benchmarks/index.js";

/** Limiares (defaults do squad; overridáveis por env/por-agente). */
export interface QualityThresholds {
  /** significância: mín. conversões de negócio na janela. */
  readonly minConversions: number;
  /** significância: mín. cliques na janela (alternativa às conversões). */
  readonly minClicks: number;
  /** fadiga: queda relativa de CTR (%) semana/semana. */
  readonly fatigueCtrDropPct: number;
  /** fadiga/saturação: frequência acima disso é sinal (teto GERAL; fallback sem estágio). */
  readonly fatigueFrequency: number;
  /**
   * Teto de frequência por estágio de público (§Bloco 2): prospecção satura cedo
   * (público amplo), remarketing tolera frequência alta (público pequeno). Aplicado
   * quando o adset tem `audience.stage`; sem estágio → `fatigueFrequency`.
   */
  readonly frequencyCapByStage: { readonly prospecting: number; readonly remarketing: number };
  /** fadiga: alta do custo-por-resultado (%) vs baseline. */
  readonly fatigueCostRisePct: number;
  /** zombie: gasto mínimo na janela p/ considerar desperdício (moeda da conta). */
  readonly zombieMinSpend: number;
  /** mostrar a referência de plataforma no cold-start (sem meta E sem histórico). */
  readonly coldStartReference: boolean;
  /** tracking furado (§Bloco 2): conversas/max(conversões,1) acima disso = suspeita. */
  readonly trackingBrokenRatio: number;
  /** tracking furado: volume mínimo de conversas p/ sequer considerar a suspeita. */
  readonly trackingBrokenMinFunnel: number;
  /**
   * Piso de elegibilidade RELATIVO (playbook real, complementar ao absoluto acima):
   * gasto ≥ este múltiplo do CPA-alvo já basta como volume, mesmo com poucas
   * conversões/cliques absolutos — escala com a economia da própria conta (útil pra
   * contas de baixo volume mas gasto relativo já significativo, ex: saúde).
   */
  readonly relativeEligibilitySpendMultiplier: number;
  /**
   * CPA marginal (pivô saúde, squad): alta (%) do CPA vs baseline a partir da qual a escala
   * ganha ressalva, mesmo pra quem ainda bate a meta em média ("CPA médio mente, o marginal
   * conta a verdade"). Ver `computeScaleRessalvas` (ressalva `worsening_marginal_cpa`).
   */
  readonly marginalCpaWorsenPct: number;
  /** S6: retenção de vídeo (`videoHookRetentionPct`) abaixo disso = gancho fraco na largada
   *  (não segura atenção nos primeiros ~25% do vídeo). Métrica DURA, mas nunca vira guard
   *  (é sinal de qualidade de criativo, não de economia da ação — CLAUDE.md §7). */
  readonly weakHookRetentionMaxPct: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minConversions: 20,
  minClicks: 100,
  fatigueCtrDropPct: 20,
  fatigueFrequency: 3,
  frequencyCapByStage: { prospecting: 2.5, remarketing: 8 },
  fatigueCostRisePct: 30,
  zombieMinSpend: 50,
  coldStartReference: true,
  trackingBrokenRatio: 50,
  trackingBrokenMinFunnel: 50,
  relativeEligibilitySpendMultiplier: 2,
  marginalCpaWorsenPct: 20,
  weakHookRetentionMaxPct: 50,
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
  /**
   * Conversas iniciadas no funil (WhatsApp/Messenger). Conta como volume quando
   * `conversionBasis === "proxy"` — a conversão de negócio não é mensurável nesta
   * entidade, então a conversa (objetivo próprio dela) é o sinal de volume real.
   * Evita que conta de mensagem nunca tenha significância só por não rastrear
   * venda ali (playbook real de saúde; `[ALTO]` do ROADMAP).
   */
  readonly conversationStarted?: number;
  /** basis da conversão nesta entidade — ver `conversationStarted`. */
  readonly conversionBasis?: ConversionBasis;
  /** gasto acumulado na janela (moeda da conta) — p/ piso relativo (ver `targetCPA`). */
  readonly spend?: number;
  /**
   * CPA-alvo do dono, se definido — base do piso relativo (`spend ≥
   * relativeEligibilitySpendMultiplier × targetCPA`). Sem alvo definido, o piso
   * relativo não se aplica (nada pra escalar).
   */
  readonly targetCPA?: number;
}

/**
 * Elegibilidade de DECISÃO. Significância = volume suficiente E já rodava na
 * janela anterior (`hasBaseline`, proxy de ≥ janela — cobre também o piso de
 * "dias mínimos de veiculação" do playbook real: sem `daysActive` preciso no
 * pipeline hoje, `hasBaseline` é o gate de tempo mais conservador disponível,
 * nunca deixa passar algo mais novo do que a própria janela).
 *
 * Volume = (conversões OU cliques OU conversas-proxy, piso absoluto) OU (gasto
 * ≥ 2×CPA-alvo, piso relativo — playbook real, escala com a economia da conta).
 */
export function computeEligibility(input: EligibilityInput, t: QualityThresholds): DecisionEligibility {
  const messagingVolume = input.conversionBasis === "proxy" ? (input.conversationStarted ?? 0) : 0;
  const enoughVolumeAbsolute =
    input.conversions >= t.minConversions || input.clicks >= t.minClicks || messagingVolume >= t.minConversions;
  const enoughVolumeRelative =
    input.targetCPA !== undefined &&
    input.targetCPA > 0 &&
    input.spend !== undefined &&
    input.spend >= t.relativeEligibilitySpendMultiplier * input.targetCPA;
  return {
    hasSignificance: (enoughVolumeAbsolute || enoughVolumeRelative) && input.hasBaseline,
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
  /**
   * A entidade AINDA ENTREGA resultado: tem significância E bate a meta (ou, sem meta, está entre
   * as mais eficientes da conta). Gradua o desgaste: 2+ sinais de fadiga NUM QUE AINDA ENTREGA →
   * `creative_aging` (prepare o sucessor, não troque já); num que já não entrega → `creative_fatigue`.
   * Ausente/false → trata como não-entregando (comportamento conservador anterior). Mesma
   * determinação de "winner" de `classifyTier` (fonte única, resolvida em `enrichEntitiesQuality`).
   */
  readonly stillDelivering?: boolean;
  /** teto de frequência resolvido por estágio (§Bloco 2); ausente → `fatigueFrequency`. */
  readonly frequencyCap?: number;
  /** S6: retenção de vídeo nos primeiros 25% (%). Ausente = sem vídeo reportado — nunca
   *  assume fraco por omissão (honesto: sem dado suficiente). */
  readonly videoHookRetentionPct?: number;
  /** S6: rankings de qualidade que a própria Meta calcula (opinião independente). */
  readonly qualityRankings?: PlatformQualityRankings;
}

function hasBelowAverageRanking(rankings: PlatformQualityRankings | undefined): boolean {
  if (!rankings) return false;
  return rankings.quality === "below_average" || rankings.engagement === "below_average" || rankings.conversion === "below_average";
}

/**
 * Sinais nomeados: fadiga/desgaste (2+ de {CTR caiu, freq alta, custo subiu}) — `creative_aging`
 * quando a entidade AINDA ENTREGA (`stillDelivering`, prepare o sucessor) ou `creative_fatigue`
 * quando já não entrega (troque) —, saturação de público (freq alta isolada) e baixo volume (sem
 * significância). O teto de frequência vem do estágio quando resolvido (`frequencyCap`), senão do geral.
 * S6: `weak_hook_retention` (retenção de vídeo baixa) e `platform_quality_below_average`
 * (a Meta classifica abaixo da média em qualidade/engajamento/conversão) — ambos métrica
 * DURA (não score de LLM), mas nunca viram guard (CLAUDE.md §7): só informam NOTE/direção.
 */
export function detectHealthSignals(input: HealthInput, t: QualityThresholds): HealthSignal[] {
  const signals: HealthSignal[] = [];
  const freqCap = input.frequencyCap ?? t.fatigueFrequency;
  const freqHigh = input.frequency !== undefined && input.frequency > freqCap;
  const fatigueHits =
    (input.ctrDropPct >= t.fatigueCtrDropPct ? 1 : 0) +
    (freqHigh ? 1 : 0) +
    (input.costRisePct >= t.fatigueCostRisePct ? 1 : 0);
  // Gradua o desgaste pelo RESULTADO ABSOLUTO (não só a deterioração relativa): 2+ sinais numa
  // entidade que AINDA ENTREGA (bate a meta / segue eficiente) = `creative_aging` (prepare o
  // sucessor, não troque um vencedor provado antes de cair); num que já não entrega = `creative_fatigue`
  // (troque). Fecha o falso positivo de "trocar criativo que ainda vende" — a proteção contra
  // escalar/duplicar sob desgaste é preservada (ambos ∈ FATIGUE_SIGNALS, ver analysis-guards).
  if (fatigueHits >= 2) signals.push(input.stillDelivering ? "creative_aging" : "creative_fatigue");
  if (freqHigh) signals.push("audience_saturation");
  if (!input.hasSignificance) signals.push("low_volume");
  if (input.videoHookRetentionPct !== undefined && input.videoHookRetentionPct < t.weakHookRetentionMaxPct) {
    signals.push("weak_hook_retention");
  }
  if (hasBelowAverageRanking(input.qualityRankings)) signals.push("platform_quality_below_average");
  return signals;
}

/** Limiar de Cialdini: "menos de 3 de 7 gatilhos de persuasão presentes = deixando
 *  persuasão na mesa" (squad, robert-cialdini.md) — não é um número arbitrário. */
const WEAK_CREATIVE_MIN_PERSUASION_SIGNALS = 3;

/**
 * Sinal de criativo fraco (S4b, decisão 6): prova fraca (`proofStrength: 'weak'`) E baixa
 * densidade persuasiva (`persuasionSignals` < 3/7). Puro score de visão (LLM soft) — NUNCA
 * vira critério de guard determinístico (CLAUDE.md §7); só informa NOTE/matcher. Ausência de
 * qualquer um dos dois insumos → sem sinal (honesto: sem dado suficiente, não assume fraco).
 */
export function detectCreativeWeakness(
  proofStrength: CreativeProofStrength | undefined,
  persuasionSignals: number | undefined,
): readonly HealthSignal[] {
  if (proofStrength === "weak" && persuasionSignals !== undefined && persuasionSignals < WEAK_CREATIVE_MIN_PERSUASION_SIGNALS) {
    return ["weak_creative"];
  }
  return [];
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
  /** faixas de custo já resolvidas na moeda da conta (ausente = não injeta custo). */
  readonly costTable?: Partial<Record<OutcomeKind, RangeBand>>;
  /** bandas de CTR override (senão default de plataforma). */
  readonly ctrBands?: CtrBands;
  /** frequência de alerta override (senão default de plataforma). */
  readonly frequencyAlert?: number;
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

/** Teto de frequência saudável por estágio de público — SEMPRE concreto (nunca undefined,
 *  ao contrário do cálculo inline de `enrichEntitiesQuality`): sem estágio, cai no teto
 *  geral (`fatigueFrequency`). Reusado pelo guard de teto de escala por audiência (Fase 4). */
export function resolveFrequencyCap(stage: AudienceStage | undefined, t: QualityThresholds): number {
  if (stage === "remarketing") return t.frequencyCapByStage.remarketing;
  if (stage === "prospecting" || stage === "unknown") return t.frequencyCapByStage.prospecting;
  return t.fatigueFrequency;
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
    const conversationStarted = e.funnel?.counts?.conversation_started ?? 0;
    const eligibility = computeEligibility(
      {
        conversions,
        clicks,
        hasBaseline,
        conversationStarted,
        ...(e.conversionBasis ? { conversionBasis: e.conversionBasis } : {}),
        spend: e.metrics.spend,
        ...(goals.targetCPA !== undefined ? { targetCPA: goals.targetCPA } : {}),
      },
      t,
    );

    const ctrDropPct = dropPct(e.metrics.ctr, e.deltaVsBaseline.ctr);
    const costMetric = typeof e.metrics.cpa === "number" ? "cpa" : "cpc";
    const costRisePct = risePct(e.metrics[costMetric], e.deltaVsBaseline[costMetric]);
    // teto de frequência por estágio (adset com público); sem estágio → teto geral.
    const frequencyCap = resolveFrequencyCap(e.audience?.stage, t);
    // eficiência só vale p/ quem tem CPA (mesma base do pool q1).
    const cpa = typeof e.metrics.cpa === "number" && e.metrics.cpa > 0 ? e.metrics.cpa : undefined;
    // "ainda entrega resultado" (fonte única com o tier `winner`): significância + bate a meta OU,
    // sem meta, top-eficiência da conta. Gradua o desgaste (aging × fatigue) no detector abaixo —
    // computado ANTES dele e reusado no `classifyTier` (zero divergência com a classificação winner).
    const beatsTarget = beatsTargetFor(e, goals);
    const topEfficiencyNoTarget = !ctx.hasTarget && cpa !== undefined && cpa <= q1;
    const stillDelivering = eligibility.hasSignificance && (beatsTarget || topEfficiencyNoTarget);
    const healthSignals = detectHealthSignals(
      {
        ...(e.metrics.frequency !== undefined ? { frequency: e.metrics.frequency } : {}),
        ctrDropPct,
        costRisePct,
        hasSignificance: eligibility.hasSignificance,
        stillDelivering,
        frequencyCap,
        ...(e.metrics.videoHookRetentionPct !== undefined ? { videoHookRetentionPct: e.metrics.videoHookRetentionPct } : {}),
        ...(e.qualityRankings ? { qualityRankings: e.qualityRankings } : {}),
      },
      t,
    );

    // sinal de vida: conversão de negócio, OU conversão-proxy (objetivo próprio), OU
    // conversas no funil. Ausência total (com gasto, fora de learning) = zumbi.
    const hasSignOfLife = conversions > 0 || typeof e.proxy?.cpa === "number" || conversationStarted > 0;
    const tier = classifyTier(
      {
        conversions,
        spend: e.metrics.spend,
        hasSignificance: eligibility.hasSignificance,
        beatsTarget,
        belowTarget: e.flags.some((f) => BELOW_TARGET_FLAGS.has(f)),
        worseThanBaseline: costRisePct >= t.fatigueCostRisePct,
        topEfficiencyNoTarget,
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
          ...(ctx.ctrBands ? { ctrBands: ctx.ctrBands } : {}),
          ...(ctx.frequencyAlert !== undefined ? { frequencyAlert: ctx.frequencyAlert } : {}),
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
