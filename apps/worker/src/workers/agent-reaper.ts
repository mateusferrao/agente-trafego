// Worker BullMQ da fila `agent-run-reaper` (3b): consome o tick recorrente e
// marca como failed os runs presos in-flight (crash duro) — libera o índice
// único parcial p/ o agente voltar a rodar. Ver run-reaper.ts.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { AGENT_REAPER_QUEUE, type AgentReaperTickPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { createRunReaper } from "../modules/dispatch/run-reaper.js";

export function startAgentReaperWorker(
  deps: WorkerDeps,
  connection: Redis,
): Worker<AgentReaperTickPayload> {
  const reaper = createRunReaper({
    db: deps.db,
    logger: deps.logger,
    staleMinutes: deps.reaper.staleMinutes,
  });

  return new Worker<AgentReaperTickPayload>(
    AGENT_REAPER_QUEUE,
    async () => {
      const count = await reaper.reapStale();
      deps.logger.debug({ count }, "reaper:tick");
    },
    { connection },
  );
}
