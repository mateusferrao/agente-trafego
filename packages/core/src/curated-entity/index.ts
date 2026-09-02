// Snapshot curado de UMA entidade (S1 — pivô saúde) — projeção estável de `EntitySummary`
// pensada pra persistir em `entity_analyses.curatedJson` e alimentar chat/UI/redator sem
// reler o brief inteiro do run (que não sobrevive além do run em memória). PURO.

import type { CuratedEntitySnapshot, EntitySummary } from "@trafego/shared";

export type { CuratedEntitySnapshot };

/**
 * `isCBO` = true quando a CAMPANHA tem orçamento PRÓPRIO (CBO); false = por conjunto/adset
 * (ABO, o budget mora nos adsets filhos). É um conceito de CAMPANHA — pra uma entidade
 * `campaign`, inferido da presença de `budget` (ABO nunca tem esse campo na campanha).
 * Pra uma entidade `adset` (S8b — diagnóstico por-adset SÓ existe em campanha ABO,
 * `deriveAdsetUnits` já garante isso), `isCBO` é SEMPRE `false`: usar `adset.budget != null`
 * aqui daria `true` (todo adset ABO tem orçamento próprio), o oposto do que o campo
 * significa — a campanha-mãe (não o adset) é quem nunca é CBO nesse cenário.
 */
export function buildCuratedEntitySnapshot(entity: EntitySummary): CuratedEntitySnapshot {
  return {
    ...(entity.campaignId ? { campaignId: entity.campaignId } : {}),
    ...(entity.budget ? { budget: entity.budget } : {}),
    ...(entity.atBudgetCeiling !== undefined ? { atBudgetCeiling: entity.atBudgetCeiling } : {}),
    isCBO: entity.level === "campaign" ? entity.budget != null : false,
    ...(entity.tier ? { tier: entity.tier } : {}),
    ...(entity.audience ? { audience: entity.audience } : {}),
    ...(entity.funnel ? { funnel: entity.funnel } : {}),
    ...(entity.conversionBasis ? { conversionBasis: entity.conversionBasis } : {}),
    ...(entity.healthSignals && entity.healthSignals.length > 0 ? { healthSignals: entity.healthSignals } : {}),
    ...(entity.eligibility ? { eligibility: entity.eligibility } : {}),
    ...(entity.benchmarkRef ? { benchmarkRef: entity.benchmarkRef } : {}),
  };
}

const DEFAULT_BUDGET_CEILING_CAP = 3;

/**
 * Nomes das campanhas ATIVAS sem folga de orçamento (`atBudgetCeiling === true`) — pro
 * redator (notify/prompt.ts) liderar por isso na mensagem proativa (S1). Pausada no teto
 * não é ação a liderar (nada rodando pra escalar); cap evita listar dezenas numa conta grande.
 */
export function campaignsAtBudgetCeiling(campaigns: readonly EntitySummary[], max = DEFAULT_BUDGET_CEILING_CAP): readonly string[] {
  return campaigns
    .filter((c) => c.status === "active" && c.atBudgetCeiling === true)
    .slice(0, max)
    .map((c) => c.name);
}
