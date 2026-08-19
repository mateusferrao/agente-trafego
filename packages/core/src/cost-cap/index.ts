// Regra pura do cap de custo LLM por org/período (§8/§11). A leitura do gasto e do
// cap por-org (guardrail_configs) fica na casca (IO); aqui só a DECISÃO — testável
// sem mock, reusada pela API (trigger on-demand) e pelo worker (dispatch do cron).

/**
 * Resolve o cap efetivo: cap por-org (guardrail_configs.llm_cost_cap) quando > 0,
 * senão o default global (env). 0 em ambos = SEM cap.
 */
export function resolveCostCapUsd(orgCapUsd: number | null | undefined, envCapUsd: number): number {
  return orgCapUsd && orgCapUsd > 0 ? orgCapUsd : envCapUsd;
}

/**
 * Estourou o cap? Só bloqueia com cap > 0 e gasto conhecido ≥ cap. Custo
 * ausente/parcial NÃO bloqueia (fail-open — "custo ausente ≠ zero", §11).
 */
export function isOverCostCap(spentUsd: number | null | undefined, capUsd: number): boolean {
  if (capUsd <= 0) return false;
  if (spentUsd === null || spentUsd === undefined) return false;
  return spentUsd >= capUsd;
}

/**
 * Período de metering ("YYYY-MM", UTC) que o `MeteringPort` usa como janela do cap.
 * Puro (relógio injetado pela casca) — um lugar só p/ o formato do período.
 */
export function usagePeriod(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
