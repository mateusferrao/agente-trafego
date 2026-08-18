// Worker BullMQ da fila `agent-runs`: processa jobs de análise do Grafo A.
// Dois modos:
//  - execute: novo run (cron ou on-demand) → graph.invoke(initialState, { thread_id })
//  - resume: aprovação resolvida → graph.invoke(new Command({ resume }), { thread_id })
// O checkpointer Postgres garante HITL durável (interrupt/resume entre jobs).

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "../composition.js";
import { buildAccountAnalysisGraph } from "../graphs/account-analysis/graph.js";

export const AGENT_RUNS_QUEUE = "agent-runs";

/** Payload dos jobs desta fila. */
export type AgentRunJob =
  | {
      readonly mode: "execute";
      readonly trigger: "cron" | "on_demand";
      readonly orgId: string;
      readonly agentId: string;
      readonly adAccountId: string;
    }
  | {
      readonly mode: "resume";
      readonly runId: string;
      readonly approvalId: string;
      readonly approvedActionIds: readonly string[];
    };

export function startAgentRunsWorker(deps: WorkerDeps, connection: Redis): Worker {
  const graph = buildAccountAnalysisGraph(deps);
  const { logger } = deps;

  return new Worker<AgentRunJob>(
    AGENT_RUNS_QUEUE,
    async (job) => {
      const data = job.data;
      if (data.mode === "execute") {
        logger.info({ jobId: job.id, adAccountId: data.adAccountId }, "agent-run:execute");
        // TODO: montar initialState (runId novo, config snapshot) e thread_id = runId.
        // await graph.invoke(initialState, { configurable: { thread_id: runId } });
        void graph;
        return;
      }
      // mode === "resume"
      logger.info({ jobId: job.id, runId: data.runId }, "agent-run:resume");
      // TODO: resolver approval no ApprovalPort → resume:
      // await graph.invoke(new Command({ resume: { approvedActions } }),
      //                    { configurable: { thread_id: data.runId } });
    },
    { connection },
  );
}
