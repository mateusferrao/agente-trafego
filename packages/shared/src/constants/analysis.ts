// Fonte ÚNICA dos limites/defaults da janela de análise (Fatia 4). Antes duplicados
// em env, worker/config, api/schema e web — consolidados aqui (CLAUDE.md → sem string
// mágica / fonte única). A janela é quantos dias o agente analisa; o baseline espelha
// o mesmo período imediatamente anterior. Teto 30d (janela+baseline=60d < retenção).
export const ANALYSIS_WINDOW_MIN_DAYS = 1;
export const ANALYSIS_WINDOW_MAX_DAYS = 30;
export const ANALYSIS_WINDOW_DEFAULT_DAYS = 7;

/** Fuso default (ICP BR) — usado no schema da org e como base da UI (fonte única). */
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";
