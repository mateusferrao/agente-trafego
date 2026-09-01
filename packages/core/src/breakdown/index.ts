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

/** Segmentos com gasto ≥ piso — evita que um segmento com gasto irrisório (custo
 *  instável) produza um spread falso-positivo. Exportado: o caller (brief) anexa só
 *  estes ao `AccountBrief` — a NOTE do kernel afirma "já filtrado por materialidade",
 *  então os segmentos abaixo do piso nunca podem chegar ao LLM. */
export function eligibleBreakdownSegments(
  segments: readonly BreakdownSegment[],
  t: BreakdownThresholds = DEFAULT_BREAKDOWN_THRESHOLDS,
): readonly BreakdownSegment[] {
  return segments.filter((s) => s.metrics.spend >= t.minSpendPerSegment);
}

function costOf(segment: BreakdownSegment, basis: "cpa" | "cpc"): number | undefined {
  const v = segment.metrics[basis];
  return typeof v === "number" && v > 0 ? v : undefined;
}

/**
 * Custos comparáveis dos segmentos elegíveis, NUMA ÚNICA base — CPA quando ≥2
 * segmentos têm conversão de negócio (mesma base); senão CPC quando ≥2 têm clique.
 * NUNCA mistura as duas no mesmo pool: CPA e CPC medem coisas diferentes — comparar
 * entre bases infla o spread artificialmente e pode apontar pro segmento ERRADO (ex:
 * segmento sem conversão nenhuma parecendo "mais barato" só por medir CPC, não CPA).
 */
function costsForComparison(eligible: readonly BreakdownSegment[]): readonly number[] {
  const cpaCosts = eligible.map((s) => costOf(s, "cpa")).filter((c): c is number => c !== undefined);
  if (cpaCosts.length >= 2) return cpaCosts;
  const cpcCosts = eligible.map((s) => costOf(s, "cpc")).filter((c): c is number => c !== undefined);
  return cpcCosts.length >= 2 ? cpcCosts : [];
}

/**
 * Há spread MATERIAL (acionável) entre os segmentos do breakdown? Só considera
 * segmentos com gasto ≥ `minSpendPerSegment` (piso, evita outlier), comparados
 * NUMA ÚNICA base (CPA ou CPC, nunca as duas); material quando
 * `(max-min)/min*100 >= minSpreadPct`.
 */
export function hasMaterialSpread(
  segments: readonly BreakdownSegment[],
  t: BreakdownThresholds = DEFAULT_BREAKDOWN_THRESHOLDS,
): boolean {
  const costs = costsForComparison(eligibleBreakdownSegments(segments, t));
  if (costs.length < 2) return false;
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  if (min <= 0) return false;
  return ((max - min) / min) * 100 >= t.minSpreadPct;
}
