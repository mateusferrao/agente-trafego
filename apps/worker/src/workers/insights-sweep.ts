// Worker BullMQ da fila `insights-sweep` (6a-2): consome o tick recorrente e roda o
// sweep de frescura — varre contas ativas, aplica `shouldSync` e enfileira sync-only
// só p/ as velhas (stagger). Sem LLM. Ver modules/insights/sweep.ts.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { INSIGHTS_SWEEP_QUEUE, type InsightsSweepTickPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { createDrizzleInsightsSnapshotsRepo } from "../modules/insights/repo.js";
import { createInsightsSweep } from "../modules/insights/sweep.js";

export function startInsightsSweepWorker(
  deps: WorkerDeps,
  connection: Redis,
): Worker<InsightsSweepTickPayload> {
  const sweep = createInsightsSweep({
    db: deps.db,
    repo: createDrizzleInsightsSnapshotsRepo(deps.db),
    scheduler: deps.ports.scheduler,
    logger: deps.logger,
    thresholdMin: deps.insights.freshThresholdMin,
    now: () => Date.now(),
    // reusa a janela de stagger da análise (espalha os enqueues sem bater a Meta juntas).
    staggerWindowMs: deps.cron.jitterMs,
  });

  return new Worker<InsightsSweepTickPayload>(
    INSIGHTS_SWEEP_QUEUE,
    async () => {
      const res = await sweep.sweep();
      deps.logger.debug(res, "sweep:done");
    },
    { connection },
  );
}
