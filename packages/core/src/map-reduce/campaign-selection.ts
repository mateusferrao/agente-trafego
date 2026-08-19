// Seleção PURA das campanhas a analisar a fundo (S3). Compõe duas peças que já
// existem: `rankAndSelect` (cobertura→profundidade: flagadas sempre + top-N por
// escore) e `selectUnitsToAnalyze` (incremental/deep sobre as candidatas). As
// campanhas fora do top-N entram RESUMIDAS no brief (não recebem call profunda).

import type { CampaignUnit, EntitySummary } from "@trafego/shared";
import { rankAndSelect } from "../brief/index.js";
import { selectUnitsToAnalyze, type LastUnit, type SelectUnitsConfig } from "./index.js";

export interface SelectCampaignsConfig extends SelectUnitsConfig {
  /** teto de campanhas profundas (flagadas/mudadas sempre entram por cima do escore). */
  readonly topN: number;
}

export interface CampaignSelection {
  /** campanhas que recebem a call profunda de LLM neste run. */
  readonly toAnalyze: readonly CampaignUnit[];
  /** candidatas do top-N que herdam a última análise (incremental). */
  readonly toInherit: readonly CampaignUnit[];
  /** fora do top-N — só resumidas no brief (sem análise por-campanha). */
  readonly summarized: readonly CampaignUnit[];
}

/**
 * Decide, entre as campanhas ativas, quais analisar a fundo. Passo 1: `rankAndSelect`
 * corta pro top-N (flagadas sempre incluídas). Passo 2: `selectUnitsToAnalyze` aplica
 * a política (deep→todas; incremental→só mudadas/novas) sobre as candidatas. Puro.
 */
export function selectCampaignsToAnalyze(
  units: readonly CampaignUnit[],
  lastByEntityId: ReadonlyMap<string, LastUnit>,
  cfg: SelectCampaignsConfig,
): CampaignSelection {
  const unitById = new Map(units.map((u) => [u.campaign.id, u]));
  const summaries = units.map((u) => u.campaign);

  const candidateIds = new Set(rankAndSelect([...summaries], cfg.topN).map((s: EntitySummary) => s.id));
  const candidateSummaries = summaries.filter((s) => candidateIds.has(s.id));
  const summarized = units.filter((u) => !candidateIds.has(u.campaign.id));

  const selection = selectUnitsToAnalyze(candidateSummaries, lastByEntityId, cfg);
  return {
    toAnalyze: mapUnits(selection.toAnalyze, unitById),
    toInherit: mapUnits(selection.toInherit, unitById),
    summarized,
  };
}

function mapUnits(
  summaries: readonly EntitySummary[],
  unitById: ReadonlyMap<string, CampaignUnit>,
): CampaignUnit[] {
  return summaries.map((s) => unitById.get(s.id)).filter((u): u is CampaignUnit => u !== undefined);
}
