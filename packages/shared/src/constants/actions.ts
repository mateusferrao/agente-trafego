/**
 * Chaves/valores dos `Action.params` de budget + toolKey de undo. `Action.params` é
 * `Record<string, unknown>` (sem checagem do compilador) — centralizar aqui evita string
 * mágica espalhada e rename silencioso. Contrato: `pct` = MAGNITUDE (≥0), `mode` = sinal.
 */
export const ACTION_PARAM_MODE = "mode";
export const ACTION_PARAM_PCT = "pct";
export const BUDGET_MODE_DECREASE = "decrease";
export const BUDGET_MODE_INCREASE = "increase";

/** toolKey do registro de undo (reaplica o before_state). Fonte única (executor + API). */
export const UNDO_TOOL_KEY = "undo";
