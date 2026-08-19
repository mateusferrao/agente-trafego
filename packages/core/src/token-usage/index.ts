/**
 * Acumulador de uso/custo de LLM ao longo de um run (várias chamadas). PURO.
 *
 * Regra-mestra: **custo ausente ≠ custo zero.** Se nenhuma chamada reportou custo,
 * `costUsd` fica ausente (nunca 0 — 0 diria ao billing que o run foi grátis). Os
 * contadores `costReportedCalls`/`costMissingCalls` marcam runs parciais para o
 * billing cair no preço de tabela em vez de subcobrar.
 */

/** Uso de uma única chamada (shape estrutural de LLMUsage, sem acoplar à porta). */
export interface SingleCallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
  readonly costUsd?: number;
}

export interface AccumulatedTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  /** ausente quando nenhuma chamada reportou custo. */
  readonly costUsd?: number;
  readonly costReportedCalls: number;
  readonly costMissingCalls: number;
}

const EMPTY: AccumulatedTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costReportedCalls: 0,
  costMissingCalls: 0,
};

export function addTokenUsage(
  current: AccumulatedTokenUsage | undefined,
  usage: SingleCallUsage,
): AccumulatedTokenUsage {
  const base = current ?? EMPTY;
  const hasCost = typeof usage.costUsd === "number";
  return {
    inputTokens: base.inputTokens + usage.inputTokens,
    outputTokens: base.outputTokens + usage.outputTokens,
    cachedTokens: base.cachedTokens + (usage.cachedTokens ?? 0),
    ...(hasCost || base.costUsd !== undefined
      ? { costUsd: (base.costUsd ?? 0) + (usage.costUsd ?? 0) }
      : {}),
    costReportedCalls: base.costReportedCalls + (hasCost ? 1 : 0),
    costMissingCalls: base.costMissingCalls + (hasCost ? 0 : 1),
  };
}

/** Run com algumas chamadas reportando custo e outras não → billing usa fallback. */
export function isCostPartial(usage: AccumulatedTokenUsage): boolean {
  return usage.costReportedCalls > 0 && usage.costMissingCalls > 0;
}

/** Custo total p/ `agent_runs.cost_snapshot` — `null` se nada foi reportado. */
export function costSnapshotFromUsage(usage: AccumulatedTokenUsage): number | null {
  return usage.costUsd ?? null;
}
