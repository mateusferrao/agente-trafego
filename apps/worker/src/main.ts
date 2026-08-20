// Entrypoint do worker (processo separado da api — mesmo repo, entrypoint diferente).
// Boot: composition root → sobe workers BullMQ (agent-runs + insights-sync) →
// shutdown gracioso. Cron por conta + inbound (webhook) entram nas fatias 3b/5b.

import { Redis } from "ioredis";
import { buildComposition, loadConfig } from "./composition.js";
import { startAgentRunsWorker } from "./workers/agent-runs.js";
import { startAgentCronDispatchWorker } from "./workers/agent-cron-dispatch.js";
import { startAgentReaperWorker } from "./workers/agent-reaper.js";
import { startInsightsSyncWorker } from "./workers/insights-sync.js";
import { startScheduleResyncWorker } from "./workers/schedule-resync.js";
import { startActionUndoWorker } from "./workers/action-undo.js";
import { makeAccountCron } from "./schedulers/account-cron.js";
import { createRunReaper } from "./modules/dispatch/run-reaper.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await buildComposition();
  const { logger } = deps;

  // conexão Redis dedicada aos workers (BullMQ exige maxRetriesPerRequest=null)
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  // 3a: loop de análise read-only (agent-runs) + sync de insights (2a).
  // 3b: dispatch do cron (cria run por conta no horário) + cadência por conta.
  const cron = makeAccountCron(deps);
  const agentRuns = startAgentRunsWorker(deps, connection);
  const cronDispatch = startAgentCronDispatchWorker(deps, connection);
  const reaper = startAgentReaperWorker(deps, connection);
  const insightsSync = startInsightsSyncWorker(deps, connection);
  // resync de schedule por conta (Fatia 4): consome os jobs que a API enfileira ao
  // salvar a cadência — worker é o dono único do scheduler.
  const scheduleResync = startScheduleResyncWorker(deps, connection, cron);

  // undo de ação (5a): consome os jobs que a API enfileira ao pedir "reverter".
  const actionUndo = startActionUndoWorker(deps, connection);

  // Sincroniza os schedulers recorrentes a partir dos agentes ativos (idempotente)
  // + agenda o reaper (singleton) e faz uma varredura de boot (limpa presos de um
  // crash anterior antes de esperar o 1º tick).
  await cron.syncAllFromDb().catch((err: unknown) => logger.error({ err }, "cron:sync_all falhou"));
  await cron.ensureReaperSchedule().catch((err: unknown) => logger.error({ err }, "reaper:schedule falhou"));
  await createRunReaper({ db: deps.db, logger, staleMinutes: deps.reaper.staleMinutes })
    .reapStale()
    .catch((err: unknown) => logger.error({ err }, "reaper:boot sweep falhou"));
  logger.info("worker up: agent-runs (3a) + cron-dispatch + reaper (3b) + insights-sync (2a)");

  // shutdown gracioso (drena jobs em andamento antes de sair)
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await Promise.allSettled([
      agentRuns.close(),
      cronDispatch.close(),
      reaper.close(),
      insightsSync.close(),
      scheduleResync.close(),
      actionUndo.close(),
    ]);
    await Promise.allSettled([connection.quit(), deps.redis.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // sem logger garantido aqui → console de última instância
  console.error("worker failed to boot", err);
  process.exit(1);
});
