// Worker BullMQ da fila `agent-cron-dispatch` (3b): consome o "tick" do Job
// Scheduler recorrente e delega ao RunDispatcher (cria run + guards + enfileira
// execute). Mantém o scheduler burro e a criação de run num lugar só.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { AGENT_CRON_QUEUE, type AgentCronDispatchPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { createRunDispatcher } from "../modules/dispatch/run-dispatcher.js";

export function startAgentCronDispatchWorker(
  deps: WorkerDeps,
  connection: Redis,
): Worker<AgentCronDispatchPayload> {
  const dispatcher = createRunDispatcher({
    db: deps.db,
    scheduler: deps.ports.scheduler,
    logger: deps.logger,
    envCostCapUsd: deps.costCapUsd,
  });
  const { logger } = deps;

  return new Worker<AgentCronDispatchPayload>(
    AGENT_CRON_QUEUE,
    async (job) => {
      const outcome = await dispatcher.dispatch(job.data);
      logger.info({ jobId: job.id, adAccountId: job.data.adAccountId, outcome }, "cron:dispatch");
    },
    { connection },
  );
}
