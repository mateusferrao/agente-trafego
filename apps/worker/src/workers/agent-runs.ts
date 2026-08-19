// Worker BullMQ da fila `agent-runs`: processa jobs de análise do Grafo A.
//
// 3a = modo `execute` read-only: monta o estado inicial e roda o grafo
// (load→fetch→playbook→llm→build→record). O grafo abre/fecha o `agent_run`; se
// algo falha no meio, aqui fechamos o run como `failed` com mensagem amigável.
// O modo `resume` (HITL durável) entra na 5b, com o checkpointer Postgres.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { AGENT_RUNS_QUEUE, type AgentRunExecutePayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { buildAccountAnalysisGraph } from "../graphs/account-analysis/graph.js";
import { createAnalysisRepo } from "../modules/analysis/repo.js";
import { AnalysisError, friendlyFailureMessage } from "../modules/analysis/errors.js";

export { AGENT_RUNS_QUEUE };

/** Payload dos jobs desta fila. `execute` (3a) + `resume` (HITL, 5b). */
export type AgentRunJob =
  | AgentRunExecutePayload
  | {
      readonly mode: "resume";
      readonly runId: string;
      readonly approvalId: string;
      readonly approvedActionIds: readonly string[];
    };

export function startAgentRunsWorker(deps: WorkerDeps, connection: Redis): Worker<AgentRunJob> {
  const graph = buildAccountAnalysisGraph(deps);
  const repo = createAnalysisRepo(deps.db);
  const { logger } = deps;

  return new Worker<AgentRunJob>(
    AGENT_RUNS_QUEUE,
    async (job) => {
      const data = job.data;
      if (data.mode !== "execute") {
        // resume (HITL) = 5b. Ignora por ora.
        logger.warn({ jobId: job.id, mode: data.mode }, "agent-run:modo ainda não suportado");
        return;
      }

      logger.info({ jobId: job.id, runId: data.runId, adAccountId: data.adAccountId }, "agent-run:execute");
      try {
        await graph.invoke({
          runId: data.runId,
          orgId: data.orgId,
          agentId: data.agentId,
          adAccountId: data.adAccountId,
          trigger: data.trigger,
        });
      } catch (err) {
        // erro esperado (token/conta/LLM) = warn; inesperado = error. Em ambos,
        // fechamos o run como failed com mensagem amigável (fonte da verdade p/ o site).
        if (err instanceof AnalysisError) {
          logger.warn({ jobId: job.id, runId: data.runId, code: err.code }, "agent-run:falha tratada");
        } else {
          logger.error({ jobId: job.id, runId: data.runId, err }, "agent-run:falha inesperada");
        }
        await repo.closeRun(data.orgId, data.runId, {
          status: "failed",
          summary: friendlyFailureMessage(err),
          partial: false,
          tokenUsage: null,
          costSnapshot: null,
        });
      }
    },
    { connection },
  );
}
