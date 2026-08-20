// Worker BullMQ da fila `action-undo` (5a): a API valida a posse + enfileira; aqui
// o worker (dono do governor/escrita) carrega o `agent_tool_calls` (org-scoped via
// join no run), reaplica o `before_state` na Meta e registra o undo (idempotente).

import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { agentRuns, agents, agentToolCalls } from "@trafego/db";
import { ACTION_UNDO_QUEUE, type ActionUndoPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { createAnalysisRepo } from "../modules/analysis/repo.js";
import { makeMetaToolExecutor } from "../executors/meta-tools.js";

export function startActionUndoWorker(deps: WorkerDeps, connection: Redis): Worker<ActionUndoPayload> {
  const { db, logger, ports } = deps;
  const repo = createAnalysisRepo(db);
  const executor = makeMetaToolExecutor(deps);

  return new Worker<ActionUndoPayload>(
    ACTION_UNDO_QUEUE,
    async (job) => {
      const { orgId, toolCallId, force } = job.data;

      // carrega o tool_call org-scoped (join no run) + deriva a CONTA do próprio
      // tool_call (via agente) — não confia no adAccountId do payload (posse↔conta
      // fechada no ponto de escrita, não só na API que enfileira).
      const [tc] = await db
        .select({
          id: agentToolCalls.id,
          runId: agentToolCalls.runId,
          beforeState: agentToolCalls.beforeState,
          args: agentToolCalls.args,
          result: agentToolCalls.result,
          adAccountId: agents.adAccountId,
        })
        .from(agentToolCalls)
        .innerJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
        .innerJoin(agents, eq(agentRuns.agentId, agents.id))
        .where(and(eq(agentToolCalls.id, toolCallId), eq(agentRuns.orgId, orgId)))
        .limit(1);
      if (!tc) {
        logger.warn({ toolCallId, orgId }, "undo:tool_call não encontrado (org-scoped)");
        return;
      }

      const account = await repo.loadAccount(orgId, tc.adAccountId);
      if (!account) {
        logger.warn({ orgId, adAccountId: tc.adAccountId }, "undo:conta não encontrada");
        return;
      }
      const accessToken = ports.vault.decrypt(account.tokenCripto);
      const ref = { adAccountId: account.metaAdAccountId, accessToken };

      const res = await executor.revert({ orgId, account: ref, toolCall: tc, force: force ?? false });
      logger.info(
        { toolCallId, reverted: res.reverted, blockedByDrift: res.blockedByDrift, reason: res.reason },
        "undo:processado",
      );
    },
    { connection },
  );
}
