// Computa os campos de apresentação das ações REAIS a partir de `agent_tool_calls`
// crus (reais + undo/undo_blocked). Reusado pela mini-surface (por conta,
// `agents/service.ts`) e pela caixa global de revertíveis (`/aprovações`,
// cross-conta, `approvals/service.ts`) — mesma regra de undoable/revertBlocked,
// dois escopos de query. Vive fora das slices (`lib`) por ser cross-slice.

import { UNDO_BLOCKED_TOOL_KEY, UNDO_TOOL_KEY } from "@trafego/shared";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Linha crua de `agent_tool_calls` (inclui as de undo/undo_blocked). */
export interface ToolCallRow {
  readonly id: string;
  readonly runId: string;
  readonly toolKey: string;
  readonly idempotencyKey: string;
  readonly args: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface AppliedAction {
  readonly toolCallId: string;
  readonly runId: string;
  readonly type: string;
  readonly targetLevel: string;
  readonly targetId: string;
  readonly targetName: string | null;
  readonly simulated: boolean;
  readonly reverted: boolean;
  /** pode reverter agora (real, não revertida, dentro do TTL). */
  readonly undoable: boolean;
  /** o re-check de drift barrou o revert — precisa confirmar ("mesmo assim"). */
  readonly revertBlocked: boolean;
  readonly revertBlockedReason: string | null;
}

/** Entidades-alvo sem `name` embutido no tool_call (legado) — base do fallback por lookup. */
export function entityIdsMissingNames(rows: readonly ToolCallRow[]): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) {
    const target = (r.args as { target?: { id?: string; name?: string } }).target;
    if (target?.id && !target.name) ids.add(target.id);
  }
  return ids;
}

/**
 * Ações REAIS (exclui as próprias linhas de undo/undo_blocked — elas só alimentam
 * `reverted`/`revertBlocked` das demais). `nameByEntityId` é o fallback pra tool_calls
 * legados sem `target.name` embutido — vazio quando o chamador não faz esse lookup.
 */
export function computeAppliedActions(
  rows: readonly ToolCallRow[],
  revertTtlDays: number,
  nameByEntityId: ReadonlyMap<string, string>,
): AppliedAction[] {
  const undoneKeys = new Set(rows.map((r) => r.idempotencyKey));
  // motivo do bloqueio de revert por drift, por ação de origem (revertOf → reason).
  const blockedReasonByOrigin = new Map<string, string>();
  for (const r of rows) {
    if (r.toolKey !== UNDO_BLOCKED_TOOL_KEY) continue;
    const originId = (r.args as { revertOf?: string }).revertOf;
    const reason = (r.result as { reason?: string } | null)?.reason;
    if (originId) blockedReasonByOrigin.set(originId, reason ?? "a entidade mudou desde então");
  }
  const revertTtlMs = revertTtlDays * DAY_MS;

  return rows
    .filter((r) => r.toolKey !== UNDO_TOOL_KEY && r.toolKey !== UNDO_BLOCKED_TOOL_KEY)
    .map((r) => {
      const args = r.args as { target?: { level: string; id: string; name?: string }; dryRun?: boolean };
      const targetId = args.target?.id ?? "";
      const simulated = args.dryRun === true;
      const reverted = undoneKeys.has(`${r.id}:${UNDO_TOOL_KEY}`);
      const fresh = Date.now() - r.createdAt.getTime() <= revertTtlMs;
      return {
        toolCallId: r.id,
        runId: r.runId,
        type: r.toolKey,
        targetLevel: args.target?.level ?? "",
        targetId,
        targetName: args.target?.name ?? nameByEntityId.get(targetId) ?? null,
        simulated,
        reverted,
        undoable: !simulated && !reverted && fresh,
        revertBlocked: !reverted && blockedReasonByOrigin.has(r.id),
        revertBlockedReason: blockedReasonByOrigin.get(r.id) ?? null,
      };
    });
}
