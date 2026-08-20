import type { GuardrailConfig } from "../types/index.js";

/**
 * Defaults de guardrail — **fonte única** (espelham os defaults de coluna de
 * `guardrail_configs`). Usado por API (antes do 1º save) e worker (fallback do run).
 */
export const GUARDRAIL_DEFAULTS: GuardrailConfig = {
  maxBudgetChangePct: 20,
  maxEntitiesPerDay: 3,
  allowedActions: ["pause_entity"],
  dryRun: true,
  killSwitch: false,
};

/** Linha `guardrail_configs` (colunas) → `GuardrailConfig` (domínio). Ausente → defaults. */
export function toGuardrailConfig(
  row:
    | {
        maxBudgetChangePct: number;
        maxEntitiesPerDay: number;
        allowedActions: GuardrailConfig["allowedActions"];
        dryRun: boolean;
        killSwitch: boolean;
        llmCostCap: string | null;
      }
    | undefined,
): GuardrailConfig {
  if (!row) return GUARDRAIL_DEFAULTS;
  return {
    maxBudgetChangePct: row.maxBudgetChangePct,
    maxEntitiesPerDay: row.maxEntitiesPerDay,
    allowedActions: row.allowedActions,
    dryRun: row.dryRun,
    killSwitch: row.killSwitch,
    ...(row.llmCostCap !== null ? { llmCostCapUsd: Number(row.llmCostCap) } : {}),
  };
}
