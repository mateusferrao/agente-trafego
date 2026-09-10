// Worker BullMQ da fila `agent-run-reaper` (3b): consome o tick recorrente e
// marca como failed os runs presos in-flight (crash duro) — libera o índice
// único parcial p/ o agente voltar a rodar. Ver run-reaper.ts.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { AGENT_REAPER_QUEUE, type AgentReaperTickPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { createRunReaper } from "../modules/dispatch/run-reaper.js";
import { reapStaleCreatingDrafts } from "../modules/apply/draft-reaper.js";
import { reapStalePendingVideos } from "./creative-video-poll.js";

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
      // piggyback: reaper de vídeo `pending` órfão (cadeia de poll perdida sem restart) — recorrente.
      const videos = await reapStalePendingVideos(deps.db, deps.logger).catch((err: unknown) => {
        deps.logger.warn({ err: String(err) }, "reaper:video sweep falhou");
        return 0;
      });
      // piggyback: reaper de rascunho de criação preso em `creating` (crash no meio da saga) — G7.
      const drafts = await reapStaleCreatingDrafts(deps.db, deps.logger, deps.reaper.staleMinutes).catch((err: unknown) => {
        deps.logger.warn({ err: String(err) }, "reaper:draft sweep falhou");
        return 0;
      });
      deps.logger.debug({ count, videos, drafts }, "reaper:tick");
    },
    { connection },
  );
}
