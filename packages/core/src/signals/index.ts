// Detecção temporal de MUDANÇA MATERIAL (F4 — alerta proativo). PURA. Compara o
// dia FECHADO (D-1) vs o baseline (média/dia dos dias anteriores) por entidade e
// emite `SignalFinding`s neutros que DIRIGEM a análise (não são veredito — o run
// investiga). `detectAnomalies` (brief) é cross-sectional (entre entidades num
// instante); esta é temporal (mesma entidade ao longo do tempo). Limiares por
// sensibilidade; guardas de baseline mínimo evitam alarme sobre número pequeno.

import type { AlertSensitivity, SignalEntityRef, SignalFinding } from "@trafego/shared";

/** Um ponto de métrica (D-1 fechado ou baseline médio) — campos ausentes = sem dado. */
export interface SignalMetricPoint {
  /** conversões de negócio/entidade (o "resultado" que importa). */
  readonly results?: number;
  readonly spend?: number;
  readonly cpa?: number;
}

/** Comparação de UMA entidade: o dia fechado vs o baseline dos dias anteriores. */
export interface SignalComparison {
  readonly entityRef: SignalEntityRef;
  readonly current: SignalMetricPoint;
  readonly baseline: SignalMetricPoint;
}

interface SignalThresholds {
  /** queda mín. de resultado (%) p/ alertar. */
  readonly resultsDropPct: number;
  /** alta mín. de gasto (%) p/ alertar. */
  readonly spendSpikePct: number;
  /** alta mín. de CPA (%) p/ alertar. */
  readonly cpaSpikePct: number;
  /** resultados mín. no baseline p/ o sinal ser confiável (evita ruído de volume baixo). */
  readonly minBaselineResults: number;
  /** gasto mín./dia no baseline (unidade do snapshot) p/ o sinal de gasto valer. */
  readonly minBaselineSpend: number;
}

/** Limiares por sensibilidade (alta = alerta mais cedo; baixa = só o gritante). */
const SIGNAL_THRESHOLDS: Readonly<Record<AlertSensitivity, SignalThresholds>> = {
  low: { resultsDropPct: 50, spendSpikePct: 100, cpaSpikePct: 80, minBaselineResults: 5, minBaselineSpend: 20 },
  normal: { resultsDropPct: 40, spendSpikePct: 70, cpaSpikePct: 60, minBaselineResults: 3, minBaselineSpend: 10 },
  high: { resultsDropPct: 30, spendSpikePct: 50, cpaSpikePct: 40, minBaselineResults: 2, minBaselineSpend: 5 },
};

/** Gasto abaixo disso conta como "zerado" (parou de rodar / saiu do ar). */
const ZERO_SPEND_EPS = 0.01;

/** Variação percentual de `cur` vs `base` (base > 0). */
function pctChange(cur: number, base: number): number {
  return ((cur - base) / base) * 100;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Emite os sinais de mudança material de UMA entidade (pode ser mais de um). */
function findingsFor(c: SignalComparison, t: SignalThresholds): SignalFinding[] {
  const out: SignalFinding[] = [];
  const { current, baseline, entityRef } = c;

  // Queda de resultado (com volume de baseline suficiente p/ não ser ruído).
  const baseResults = baseline.results ?? 0;
  const curResults = current.results ?? 0;
  if (baseResults >= t.minBaselineResults && curResults < baseResults) {
    const drop = -pctChange(curResults, baseResults); // positivo = queda
    if (drop >= t.resultsDropPct) {
      out.push({ entityRef, metric: "results", direction: "drop", magnitudePct: round(drop), current: curResults, baseline: baseResults });
    }
  }

  // Gasto: zerado (parou) ou disparando — mutuamente exclusivos.
  const baseSpend = baseline.spend ?? 0;
  const curSpend = current.spend ?? 0;
  if (baseSpend >= t.minBaselineSpend) {
    if (curSpend <= ZERO_SPEND_EPS) {
      out.push({ entityRef, metric: "spend", direction: "zeroed", magnitudePct: 100, current: curSpend, baseline: baseSpend });
    } else {
      const spike = pctChange(curSpend, baseSpend);
      if (spike >= t.spendSpikePct) {
        out.push({ entityRef, metric: "spend", direction: "spike", magnitudePct: round(spike), current: curSpend, baseline: baseSpend });
      }
    }
  }

  // CPA estourando (só com CPA medido nos dois lados e volume de baseline).
  if (
    typeof current.cpa === "number" &&
    typeof baseline.cpa === "number" &&
    baseline.cpa > 0 &&
    baseResults >= t.minBaselineResults
  ) {
    const spike = pctChange(current.cpa, baseline.cpa);
    if (spike >= t.cpaSpikePct) {
      out.push({ entityRef, metric: "cpa", direction: "spike", magnitudePct: round(spike), current: current.cpa, baseline: baseline.cpa });
    }
  }

  return out;
}

/** Detecta mudanças materiais (D-1 vs baseline) em todas as entidades comparadas. */
export function detectMaterialChange(
  comparisons: readonly SignalComparison[],
  sensitivity: AlertSensitivity,
): SignalFinding[] {
  const t = SIGNAL_THRESHOLDS[sensitivity];
  return comparisons.flatMap((c) => findingsFor(c, t));
}
