// Quantificação de desperdício + Pareto 80/20 (§Bloco 2) — PURO. O "money shot"
// da auditoria: transforma tiers em números de dinheiro. Roda sobre o conjunto
// COMPLETO de campanhas (não o brief podado — senão subconta zumbis da cauda).
// Determinístico: NÃO entra no schema do LLM; é anexado ao brief e ao snapshot.

import type { AnalysisOutput, ConversionBasis, EntitySummary, WastePareto, WasteParetoItem, WasteReport } from "@trafego/shared";

/** Só destaca má alocação em quem pesa no gasto (evita ruído de item pequeno). */
const MISALLOC_MIN_SPEND_PCT = 20;
/** Mal alocado = resultado ≤ metade da fatia de gasto (gasta muito, entrega pouco). */
const MISALLOC_RESULT_RATIO = 0.5;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Resultado da entidade conforme sua base de conversão (comparável só dentro do grupo). */
function resultOf(e: EntitySummary): number | undefined {
  if (e.conversionBasis === "target") return e.metrics.conversions ?? 0;
  if (e.conversionBasis === "proxy") return e.funnel?.counts.conversation_started;
  if (e.conversionBasis === "none") return e.metrics.clicks;
  return undefined;
}

/** Pareto do grupo DOMINANTE (maior gasto) — nunca cruza bases distintas. */
function buildPareto(campaigns: readonly EntitySummary[]): WastePareto | undefined {
  const byBasis = new Map<ConversionBasis, EntitySummary[]>();
  for (const c of campaigns) {
    const basis = c.conversionBasis ?? "none";
    (byBasis.get(basis) ?? byBasis.set(basis, []).get(basis)!).push(c);
  }
  let dominant: { basis: ConversionBasis; group: EntitySummary[]; spend: number } | undefined;
  for (const [basis, group] of byBasis) {
    const spend = group.reduce((s, e) => s + (e.metrics.spend ?? 0), 0);
    if (!dominant || spend > dominant.spend) dominant = { basis, group, spend };
  }
  if (!dominant || dominant.group.length < 2) return undefined; // concentração trivial

  const groupSpend = dominant.spend;
  const groupResult = dominant.group.reduce((s, e) => s + (resultOf(e) ?? 0), 0);
  const items: WasteParetoItem[] = [...dominant.group]
    .sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0))
    .map((e) => {
      const spend = round2(e.metrics.spend ?? 0);
      const result = resultOf(e);
      const spendPct = groupSpend > 0 ? round1((spend / groupSpend) * 100) : 0;
      const resultPct = groupResult > 0 && result !== undefined ? round1((result / groupResult) * 100) : undefined;
      return {
        id: e.id,
        name: e.name,
        spend,
        spendPct,
        ...(result !== undefined ? { result } : {}),
        ...(resultPct !== undefined ? { resultPct } : {}),
      };
    });

  const misallocated = items.filter(
    (i) => i.spendPct >= MISALLOC_MIN_SPEND_PCT && i.resultPct !== undefined && i.resultPct <= i.spendPct * MISALLOC_RESULT_RATIO,
  );
  return { basis: dominant.basis, groupSpend: round2(groupSpend), items, misallocated };
}

/**
 * Desperdício da conta a partir das campanhas ENRIQUECIDAS (tier já classificado).
 * `wastedSpend` = só zumbis (dinheiro queimado); má alocação vai pro Pareto.
 */
export function computeWasteReport(campaigns: readonly EntitySummary[]): WasteReport {
  const totalSpend = round2(campaigns.reduce((s, e) => s + (e.metrics.spend ?? 0), 0));
  const zombies = campaigns
    .filter((e) => e.tier === "zombie")
    .map((e) => ({ id: e.id, name: e.name, spend: round2(e.metrics.spend ?? 0) }));
  const wastedSpend = round2(zombies.reduce((s, z) => s + z.spend, 0));
  const wastedPct = totalSpend > 0 ? round1((wastedSpend / totalSpend) * 100) : 0;
  const withSpend = campaigns.filter((c) => (c.metrics.spend ?? 0) > 0);
  const pareto = buildPareto(withSpend);
  return { totalSpend, wastedSpend, wastedPct, zombies, ...(pareto ? { pareto } : {}) };
}

/**
 * Anexa o impacto (gasto liberado no período) às recomendações de PAUSA — o dono vê
 * o valor concreto de cada ação. Determinístico; puro; só acrescenta ao rationale.
 */
export function annotateFreedSpend(
  output: AnalysisOutput,
  spendById: ReadonlyMap<string, number>,
  currency: string,
): AnalysisOutput {
  const recommendations = output.recommendations.map((r) => {
    if (r.actionType !== "pause") return r;
    const id = r.targetEntity?.externalId;
    const spend = id ? spendById.get(id) : undefined;
    if (spend === undefined || spend <= 0) return r;
    return { ...r, rationale: `${r.rationale}\n[impacto] pausar libera ~${currency} ${round2(spend)} no período.` };
  });
  return { ...output, recommendations };
}
