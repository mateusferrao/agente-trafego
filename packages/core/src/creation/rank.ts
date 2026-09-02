import type { CreativeAssetRef, PerformanceTier } from "@trafego/shared";

/**
 * Candidato a criativo p/ o ranqueamento autônomo (Fatia 7). Os campos de desempenho
 * vêm do `ad_creatives` (tier/spend já denormalizados pela análise). Puro — a casca monta.
 */
export interface CreativeCandidate {
  readonly ref: CreativeAssetRef;
  /** tier de desempenho (6c); ausente = não-provado (ex: upload sem histórico). */
  readonly tier?: PerformanceTier;
  /** gasto acumulado (unidade mínima) — significância no desempate. */
  readonly spendMinor?: number;
  /** o criativo cansou (fadiga) — excluído no refresh. */
  readonly fatigued?: boolean;
  /** já está em um anúncio ATIVO do mesmo objetivo (risco de canibalizar). */
  readonly active?: boolean;
}

export interface RankCreativesOptions {
  /** refresh: exclui os fatigados. */
  readonly excludeFatigued?: boolean;
  /** prefere mídia não-ativa no desempate (default true — evita canibalizar). */
  readonly preferInactive?: boolean;
}

/**
 * Rank do não-provado (upload sem histórico) — entre provado-bom (winner/performer) e
 * provado-ruim (underperformer/zombie). "reuse-provado-bom > upload > reuse-provado-ruim".
 */
const UNPROVEN_RANK = 2;
const TIER_RANK: Record<PerformanceTier, number> = {
  winner: 0,
  performer: 1,
  underperformer: 3,
  zombie: 4,
};

function tierRank(c: CreativeCandidate): number {
  return c.tier ? TIER_RANK[c.tier] : UNPROVEN_RANK;
}

/**
 * Ranqueia criativos p/ escolha autônoma (best-first). Ordem: tier (provado-bom → não-provado
 * → provado-ruim) → não-ativo antes de ativo (evita canibalizar) → maior gasto (significância).
 * PURO. `preferInactive` default true.
 */
export function rankCreatives(
  candidates: readonly CreativeCandidate[],
  opts: RankCreativesOptions = {},
): CreativeCandidate[] {
  const preferInactive = opts.preferInactive ?? true;
  const pool = opts.excludeFatigued ? candidates.filter((c) => !c.fatigued) : [...candidates];

  return pool.sort((a, b) => {
    const byTier = tierRank(a) - tierRank(b);
    if (byTier !== 0) return byTier;
    if (preferInactive) {
      const byActive = Number(a.active ?? false) - Number(b.active ?? false);
      if (byActive !== 0) return byActive;
    }
    return (b.spendMinor ?? 0) - (a.spendMinor ?? 0);
  });
}
