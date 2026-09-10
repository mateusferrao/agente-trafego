// Orquestração PURA-ish (IO injetado) da saga de realocação de orçamento A→B (A4). A Meta não
// tem transação → mover orçamento entre duas entidades são DUAS escritas independentes. Se a 2ª
// (destino) falha DEPOIS de a 1ª (origem) já ter descido, é preciso DEVOLVER o orçamento da
// origem (compensação); se a devolução também falha, o estado é PARCIAL e explícito (nunca
// silêncio). Esta função decide a ordem, monta a compensação e escolhe o desfecho; o `applyLeg`
// (escrita real checada) e a renderização das mensagens ficam na casca (nós do grafo) — assim a
// lógica de compensação é testável sem banco/Meta.

import { riskForAction, type GuardrailContext } from "@trafego/core";
import { ACTION_PARAM_AMOUNT_MINOR, ACTION_PARAM_MODE, BUDGET_MODE_SET } from "@trafego/shared";
import type { Action } from "@trafego/shared/types";
import type { ApplyResult } from "./apply-confirmed-action.js";

/** Aplica UMA perna (escrita checada). `ctx` varia por perna (cap diário / clamp da compensação). */
export type ApplyLeg = (action: Action, ctx: GuardrailContext, keySuffix: string) => Promise<ApplyResult>;

/** Info congelada da saga (do gate) — a origem e quanto devolver nela. */
export interface ReallocationSaga {
  readonly sourceKey: string;
  readonly sourceRestoreMinor: number;
}

/** Desfecho da saga — a casca mapeia cada caso p/ a mensagem ao usuário. */
export type ReallocationOutcome =
  /** origem não desceu (barrada/falhou) → nada movido, nada a compensar. */
  | { readonly kind: "source_failed"; readonly failed: ApplyResult }
  /** as duas pernas aplicaram (ou no-op) → realocação concluída. */
  | { readonly kind: "done" }
  /** destino falhou, mas a origem foi DEVOLVIDA → no fim nada mudou. */
  | { readonly kind: "compensated"; readonly destFailed: ApplyResult }
  /** destino falhou E a devolução também → estado PARCIAL explícito. */
  | { readonly kind: "partial"; readonly destFailed: ApplyResult; readonly compensationFailed: ApplyResult };

const wrote = (r: ApplyResult): boolean => r.kind === "applied" || r.kind === "noop";

/**
 * Roda a saga: origem → destino → (se destino falha) compensação. `baseCtx` é o contexto FRESCO
 * do início (carregado UMA vez, antes de qualquer escrita) — reusá-lo garante que a compensação:
 *  (a) NÃO é barrada por anti-compounding (a origem ainda não está em `budgetChangedToday` deste
 *      snapshot), e (b) NÃO é clampada (o budget-de-referência da origem é sobrescrito p/ o valor
 *      anterior → devolver = 0% de mudança).
 */
export async function runReallocationSaga(
  legFrom: Action,
  legTo: Action,
  saga: ReallocationSaga,
  baseCtx: GuardrailContext,
  applyLeg: ApplyLeg,
): Promise<ReallocationOutcome> {
  const outFrom = await applyLeg(legFrom, baseCtx, "realloc");
  if (!wrote(outFrom)) return { kind: "source_failed", failed: outFrom };

  // destino: soma a origem ao "tocado hoje" (cap de entidades/dia coerente com o gate do lote).
  const ctxTo: GuardrailContext = {
    ...baseCtx,
    touchedToday: new Set<string>([...(baseCtx.touchedToday ?? []), saga.sourceKey]),
  };
  const outTo = await applyLeg(legTo, ctxTo, "realloc");
  if (wrote(outTo)) return { kind: "done" };

  // destino falhou DEPOIS da origem descer → devolve o orçamento cru anterior da origem.
  const compensation: Action = {
    id: `${legFrom.id}:compensate`,
    type: "adjust_budget",
    target: legFrom.target,
    params: { [ACTION_PARAM_MODE]: BUDGET_MODE_SET, [ACTION_PARAM_AMOUNT_MINOR]: saga.sourceRestoreMinor },
    source: "llm",
    riskLevel: riskForAction("adjust_budget"),
    reason: "compensação de realocação (devolve o orçamento da origem)",
  };
  // clamp NEUTRO: budget-de-referência = o valor ANTERIOR (0% de mudança); a origem NÃO entra em
  // budgetChangedToday deste snapshot (fresco do início) → anti-compounding não barra a devolução.
  const compCtx: GuardrailContext = {
    ...baseCtx,
    budgetAmountByEntity: new Map<string, number>([...(baseCtx.budgetAmountByEntity ?? []), [saga.sourceKey, saga.sourceRestoreMinor]]),
  };
  const outComp = await applyLeg(compensation, compCtx, "compensate");
  if (wrote(outComp)) return { kind: "compensated", destFailed: outTo };
  return { kind: "partial", destFailed: outTo, compensationFailed: outComp };
}
