import type { GuardrailConfig } from "../types/index.js";

/** Defaults dos limites de GASTO NOVO (Fatia 7) — conservadores. `Minor` = unidade mínima da moeda. */
export const DEFAULT_MAX_NEW_DAILY_BUDGET_MINOR = 5000;
export const DEFAULT_MAX_NEW_CAMPAIGNS_PER_DAY = 1;
export const DEFAULT_SCALE_PCT = 50;

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
  maxNewDailyBudgetMinor: DEFAULT_MAX_NEW_DAILY_BUDGET_MINOR,
  maxNewCampaignsPerDay: DEFAULT_MAX_NEW_CAMPAIGNS_PER_DAY,
  scalePct: DEFAULT_SCALE_PCT,
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
        maxNewDailyBudgetMinor: number;
        maxNewCampaignsPerDay: number;
        scalePct: number;
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
    maxNewDailyBudgetMinor: row.maxNewDailyBudgetMinor,
    maxNewCampaignsPerDay: row.maxNewCampaignsPerDay,
    scalePct: row.scalePct,
    ...(row.llmCostCap !== null ? { llmCostCapUsd: Number(row.llmCostCap) } : {}),
  };
}
