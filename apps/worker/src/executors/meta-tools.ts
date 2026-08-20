// Executor de ESCRITA na Meta via AdsPlatformPort. Cada execução:
//  - resolve idempotencyKey (agent_tool_calls.idempotency_key) → nunca aplica 2x
//  - aplica (ou SIMULA, se dryRun) via mutate() — que devolve before/after
//  - grava agent_tool_calls (args/result/before/risk) + audit_log (before/after)
//  - registra usage_events (ação aplicada) via MeteringPort
// A regra de negócio (guardrail, autonomia, conflito) já rodou ANTES daqui.

import { eq } from "drizzle-orm";
import { agentToolCalls, auditLog } from "@trafego/db";
import type { Action } from "@trafego/shared/types";
import type { AdAccountRef, MutationResult } from "@trafego/shared/ports";
import type { OrgId, RunId } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";

/** Ator da auditoria de escrita autônoma. */
const ACTOR_AGENT = "agent";
/** Dimensão genérica de metering p/ ação aplicada (base do billing por markup). */
const USAGE_TYPE_ACTION_APPLIED = "action_applied";

export interface ExecuteActionInput {
  readonly runId: string;
  readonly orgId: string;
  readonly account: AdAccountRef;
  readonly action: Action;
  /** chave idempotente estável (`${runId}:${action.id}`). */
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
  return `${action.target.level}:${action.target.id}`;
}

export function makeMetaToolExecutor(deps: WorkerDeps) {
  const { db, ports, logger } = deps;

  /** Aplica (ou simula) uma ação de escrita, idempotente + auditada. */
  async function execute(input: ExecuteActionInput): Promise<ExecutedAction> {
    const { runId, orgId, account, action, idempotencyKey, dryRun } = input;

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
      metadata: { runId, dryRun, risk: action.riskLevel },
      before: result.before as Record<string, unknown>,
      after: result.after as Record<string, unknown>,
    });

    await ports.metering.record({
      orgId: orgId as OrgId,
      runId: runId as RunId,
      type: USAGE_TYPE_ACTION_APPLIED,
      payload: { actionType: action.type, target: targetKey(action), dryRun, risk: action.riskLevel },
    });

    logger.info({ runId, action: action.type, dryRun }, "meta-tool:applied");
    return { result, dryRun, replayed: false };
  }

  return { execute };
}

export type MetaToolExecutor = ReturnType<typeof makeMetaToolExecutor>;
