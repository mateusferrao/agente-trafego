// Materialidade de breakdown demográfico/posicionamento — PURO (Fase 4/S7, pivô saúde).
// Sem esse gate, a NOTE do kernel entraria em TODA conta mesmo quando o spread não é
// acionável — o mesmo princípio de "NOTES condicionadas por relevância" (S0b) aplicado
// ao breakdown: só vira contexto do prompt quando a diferença entre segmentos é grande
// o bastante pra render uma ação de baixo risco (abrir faixa/realocar peso), nunca por
// ruído estatístico de segmentos com gasto ínfimo.

import type { BreakdownSegment } from "@trafego/shared";

export interface BreakdownThresholds {
  /** gasto mínimo (moeda da conta) p/ um segmento entrar na comparação — evita que um
   *  segmento com gasto irrisório (CPA instável) produza um spread falso-positivo. */
  readonly minSpendPerSegment: number;
  /** spread mínimo (%) entre o custo do segmento mais caro e o mais barato p/ considerar
   *  a diferença material (acionável), não ruído. */
  readonly minSpreadPct: number;
}

export const DEFAULT_BREAKDOWN_THRESHOLDS: BreakdownThresholds = {
  minSpendPerSegment: 20,
  minSpreadPct: 30,
};

/** Custo comparável do segmento: CPA quando há conversão; senão CPC. Mesmo padrão de
 *  `enrichEntitiesQuality` (packages/core/src/quality) — nunca mistura CPA com CPC no
 *  mesmo pool, mas aqui cada segmento decide sozinho (não há pool cross-segmento). */
function comparableCost(segment: BreakdownSegment): number | undefined {
  const { cpa, cpc } = segment.metrics;
  if (typeof cpa === "number" && cpa > 0) return cpa;
  if (typeof cpc === "number" && cpc > 0) return cpc;
  return undefined;
}

/**
 * Há spread MATERIAL (acionável) entre os segmentos do breakdown? Só considera
 * segmentos com gasto ≥ `minSpendPerSegment` (piso, evita outlier); precisa de pelo
 * menos 2 custos comparáveis; material quando `(max-min)/min*100 >= minSpreadPct`.
 */
export function hasMaterialSpread(
  segments: readonly BreakdownSegment[],
  t: BreakdownThresholds = DEFAULT_BREAKDOWN_THRESHOLDS,
): boolean {
  const eligible = segments.filter((s) => s.metrics.spend >= t.minSpendPerSegment);
  const costs = eligible.map(comparableCost).filter((c): c is number => c !== undefined);
  if (costs.length < 2) return false;
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  if (min <= 0) return false;
  return ((max - min) / min) * 100 >= t.minSpreadPct;
}
