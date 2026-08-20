import type { ActionType, RiskLevel } from "@trafego/shared";
import { ACTION_PARAM_MODE, BUDGET_MODE_DECREASE } from "@trafego/shared";

/** Risco base por tipo (defaults conservadores). `adjust_budget` é refinado por params. */
const BASE_RISK: Readonly<Record<ActionType, RiskLevel>> = {
  pause_entity: "low", // parar gasto, reversível
  resume_entity: "medium", // religar volta a gastar
  set_status: "medium",
  adjust_budget: "medium", // default; cortar (decrease) vira low (ver abaixo)
};

/**
 * Risco determinístico de uma ação — **FONTE ÚNICA** (reusada por playbook,
 * recommendation e o caminho de escrita). Params-aware: `adjust_budget` no modo
 * `decrease` (cortar gasto) é `low` (auto-aplicável no `act_safe`); aumentar é
 * `medium`. Mudou o leque de tipos? o `Record` exaustivo força atualizar. PURA.
 */
export function riskForAction(type: ActionType, params?: Readonly<Record<string, unknown>>): RiskLevel {
  if (type === "adjust_budget") {
    return params?.[ACTION_PARAM_MODE] === BUDGET_MODE_DECREASE ? "low" : "medium";
  }
  return BASE_RISK[type];
}
