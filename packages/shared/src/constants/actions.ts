/**
 * Chaves/valores dos `Action.params` de budget + toolKey de undo. `Action.params` é
 * `Record<string, unknown>` (sem checagem do compilador) — centralizar aqui evita string
 * mágica espalhada e rename silencioso. Contrato: `pct` = MAGNITUDE (≥0), `mode` = sinal.
 */
export const ACTION_PARAM_MODE = "mode";
export const ACTION_PARAM_PCT = "pct";
/** Valor ABSOLUTO alvo do budget (unidade mínima/centavos), usado com `mode:'set'`. */
export const ACTION_PARAM_AMOUNT_MINOR = "amountMinor";
/** Chave do status-alvo em `set_status.params` — valor no vocabulário neutro (EntityStatus). */
export const ACTION_PARAM_STATUS = "status";
export const BUDGET_MODE_DECREASE = "decrease";
export const BUDGET_MODE_INCREASE = "increase";
/** Budget absoluto (chat, 5c): `params.amountMinor` é o alvo exato (sem % sobre o atual). */
export const BUDGET_MODE_SET = "set";

/** toolKey do registro de undo (reaplica o before_state). Fonte única (executor + API). */
export const UNDO_TOOL_KEY = "undo";
/** toolKey do registro de undo BARRADO por drift (re-check do revert, 5b). Não escreve. */
export const UNDO_BLOCKED_TOOL_KEY = "undo_blocked";
