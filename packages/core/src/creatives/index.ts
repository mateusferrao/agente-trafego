// Ranking de criativos por desempenho ("qual copy campeã") — PURO e estável.
// Sobre o desempenho denormalizado persistido em `ad_creatives` (tier/CPA/ROAS/gasto),
// sem re-derivar nada (o número vem curado do run). Alimenta a read-tool do chat.

import type { PerformanceTier } from "@trafego/shared";

export interface RankableCreative {
  readonly tier: PerformanceTier | null;
  readonly roas: number | null;
  readonly cpa: number | null;
  readonly spend: number | null;
}

/** Ordem dos tiers (menor = melhor); `null` (sem tier) vai por último. */
const TIER_RANK: Readonly<Record<PerformanceTier, number>> = {
  winner: 0,
  performer: 1,
  underperformer: 2,
  zombie: 3,
};
const NO_TIER = 99;

/**
 * Ordena "campeã→pior": tier (winner→zombie, sem-tier por último), desempate por
 * ROAS desc, depois CPA asc, depois gasto desc (mais relevante). Estável e sem mutar.
 */
export function rankAdCreatives<T extends RankableCreative>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = a.tier ? TIER_RANK[a.tier] : NO_TIER;
    const tb = b.tier ? TIER_RANK[b.tier] : NO_TIER;
    if (ta !== tb) return ta - tb;
    const ra = a.roas ?? -Infinity;
    const rb = b.roas ?? -Infinity;
    if (ra !== rb) return rb - ra;
    const ca = a.cpa ?? Infinity;
    const cb = b.cpa ?? Infinity;
    if (ca !== cb) return ca - cb;
    return (b.spend ?? 0) - (a.spend ?? 0);
  });
}
