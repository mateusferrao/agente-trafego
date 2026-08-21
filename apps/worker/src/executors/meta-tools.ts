// Executor de ESCRITA na Meta via AdsPlatformPort. Cada execução:
//  - resolve idempotencyKey (agent_tool_calls.idempotency_key) → nunca aplica 2x
//  - aplica (ou SIMULA, se dryRun) via mutate() — que devolve before/after
//  - grava agent_tool_calls (args/result/before/risk) + audit_log (before/after)
//  - registra usage_events (ação aplicada) via MeteringPort
// A regra de negócio (guardrail, autonomia, conflito) já rodou ANTES daqui.

import { eq } from "drizzle-orm";
import { agentToolCalls, auditLog } from "@trafego/db";
import type { Action, ActionTarget } from "@trafego/shared/types";
import type { AdAccountRef, MutationResult } from "@trafego/shared/ports";
import { UNDO_BLOCKED_TOOL_KEY, UNDO_TOOL_KEY, type OrgId, type RunId } from "@trafego/shared";
import { entityKeyOf } from "@trafego/core";
import type { WorkerDeps } from "../composition.js";

/** Ator da auditoria de escrita autônoma. */
const ACTOR_AGENT = "agent";
/** Dimensão genérica de metering p/ ação aplicada (base do billing por markup). */
const USAGE_TYPE_ACTION_APPLIED = "action_applied";

/** `agent_tool_call` carregado p/ o undo (org-scoped na casca que o carregou). */
export interface RevertToolCall {
  readonly id: string;
  readonly runId: string | null;
  readonly beforeState: Record<string, unknown> | null;
  readonly args: Record<string, unknown>;
  /** result da ação original ({ before, after }) — base do re-check de drift. */
  readonly result: Record<string, unknown> | null;
}

export interface RevertInput {
  readonly orgId: string;
  readonly account: AdAccountRef;
  readonly toolCall: RevertToolCall;
  /** ignora o drift (usuário confirmou "reverter mesmo assim"). */
  readonly force?: boolean;
}

export interface RevertResult {
  readonly reverted: boolean;
  readonly reason?: string;
  /** re-check barrou por drift (entidade mudou desde a ação) — pede confirmação. */
  readonly blockedByDrift?: boolean;
}

/** Campos de estado relevantes ao drift (status + budgets; ignora derivados). */
function driftFields(state: Record<string, unknown> | null | undefined): string {
  const s = state ?? {};
  return JSON.stringify({
    status: s["status"],
    daily_budget: s["daily_budget"],
    lifetime_budget: s["lifetime_budget"],
  });
}

export interface ExecuteActionInput {
  /** dono da ação — âncora do cap diário/undo/trilha (sempre presente). */
  readonly agentId: string;
  /** run de análise que originou a ação; null p/ escrita LIVRE por chat (5c). */
  readonly runId: string | null;
  readonly orgId: string;
  readonly account: AdAccountRef;
  readonly action: Action;
  /** chave idempotente estável (`${runId}:${action.id}` ou `conv:${conversationId}:${action.id}`). */
  readonly idempotencyKey: string;
  /** ensaio: simula (lê + computa) sem escrever na Meta. */
  readonly dryRun: boolean;
}

export interface ExecutedAction {
  readonly result: MutationResult;
  readonly dryRun: boolean;
  /** veio do registro idempotente (não re-aplicou). */
  readonly replayed: boolean;
}

function targetKey(action: Action): string {
  return entityKeyOf(action.target);
}

export function makeMetaToolExecutor(deps: WorkerDeps) {
  const { db, ports, logger } = deps;

  /** Aplica (ou simula) uma ação de escrita, idempotente + auditada. */
  async function execute(input: ExecuteActionInput): Promise<ExecutedAction> {
    const { agentId, runId, orgId, account, action, idempotencyKey, dryRun } = input;

    // idempotência: já aplicado? → devolve o result gravado (sem re-mutar).
    const [existing] = await db
      .select({ result: agentToolCalls.result })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing?.result) {
      const stored = existing.result as unknown as MutationResult & { dryRun?: boolean };
      return { result: stored, dryRun: stored.dryRun ?? false, replayed: true };
    }

    const result = await ports.ads.mutate(account, action, { dryRun });

    await db
      .insert(agentToolCalls)
      .values({
        agentId,
        runId,
        toolKey: action.type,
        idempotencyKey,
        risk: action.riskLevel,
        args: { target: action.target, params: action.params, source: action.source, dryRun },
        result: { ...result, dryRun },
        beforeState: result.before as Record<string, unknown>,
      })
      .onConflictDoNothing();

    await db.insert(auditLog).values({
      orgId,
      actor: ACTOR_AGENT,
      action: `meta.${action.type}${dryRun ? ".dry_run" : ""}`,
      target: targetKey(action),
      metadata: { agentId, runId, dryRun, risk: action.riskLevel },
      before: result.before as Record<string, unknown>,
      after: result.after as Record<string, unknown>,
    });

    // metering só de ações REAIS (dry-run não é faturável — não infla o markup).
    if (!dryRun) {
      await ports.metering.record({
        orgId: orgId as OrgId,
        ...(runId ? { runId: runId as RunId } : {}),
        type: USAGE_TYPE_ACTION_APPLIED,
        payload: { actionType: action.type, target: targetKey(action), risk: action.riskLevel },
      });
    }

    logger.info({ runId, action: action.type, dryRun }, "meta-tool:applied");
    return { result, dryRun, replayed: false };
  }

  /** Undo: reaplica o `before_state` de um tool_call REAL. Idempotente (`${id}:undo`). */
  async function revert(input: RevertInput): Promise<RevertResult> {
    const { orgId, account, toolCall, force } = input;
    const args = toolCall.args as { target?: ActionTarget; dryRun?: boolean };
    if (args?.dryRun) return { reverted: false, reason: "ação simulada — nada a reverter" };
    if (!toolCall.beforeState || !args?.target) return { reverted: false, reason: "sem estado anterior" };

    const undoKey = `${toolCall.id}:${UNDO_TOOL_KEY}`;
    const [existing] = await db
      .select({ id: agentToolCalls.id })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.idempotencyKey, undoKey))
      .limit(1);
    if (existing) return { reverted: true, reason: "já revertido" };

    const target = args.target;

    // re-check de DRIFT (5b): compara o estado FRESCO com o que a ação deixou (`after`).
    // Divergiu (alguém mexeu depois) e sem `force` → NÃO reverte (evita sobrescrever a
    // mudança posterior); registra o bloqueio p/ a UI pedir confirmação ("mesmo assim").
    if (!force) {
      const after = (toolCall.result as { after?: Record<string, unknown> } | null)?.after;
      if (after) {
        const current = await ports.ads.readEntityState(account, target.id);
        if (driftFields(current) !== driftFields(after)) {
          const reason = "a entidade mudou desde a ação — reverter sobrescreveria a mudança";
          await db
            .insert(agentToolCalls)
            .values({
              runId: toolCall.runId,
              toolKey: UNDO_BLOCKED_TOOL_KEY,
              idempotencyKey: `${toolCall.id}:${UNDO_BLOCKED_TOOL_KEY}`,
              risk: "low",
              args: { revertOf: toolCall.id, target },
              result: { reason, current },
            })
            .onConflictDoNothing();
          logger.info({ toolCallId: toolCall.id }, "undo:barrado por drift");
          return { reverted: false, blockedByDrift: true, reason };
        }
      }
    }

    const restore = await ports.ads.restoreEntityState(account, target.id, toolCall.beforeState);
    const targetLabel = entityKeyOf(target);

    await db
      .insert(agentToolCalls)
      .values({
        runId: toolCall.runId,
        toolKey: UNDO_TOOL_KEY,
        idempotencyKey: undoKey,
        risk: "low",
        args: { revertOf: toolCall.id, target },
        result: { ...restore },
        beforeState: restore.before as Record<string, unknown>,
      })
      .onConflictDoNothing();

    await db.insert(auditLog).values({
      orgId,
      actor: ACTOR_AGENT,
      action: `meta.${UNDO_TOOL_KEY}`,
      target: targetLabel,
      metadata: { revertOf: toolCall.id },
      before: restore.before as Record<string, unknown>,
      after: restore.after as Record<string, unknown>,
    });

    await ports.metering.record({
      orgId: orgId as OrgId,
      runId: toolCall.runId as RunId,
      type: USAGE_TYPE_ACTION_APPLIED,
      payload: { actionType: UNDO_TOOL_KEY, target: targetLabel, revertOf: toolCall.id },
    });

    logger.info({ toolCallId: toolCall.id }, "meta-tool:reverted");
    return { reverted: true };
  }

  return { execute, revert };
}

export type MetaToolExecutor = ReturnType<typeof makeMetaToolExecutor>;
