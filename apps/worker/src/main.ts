// Entrypoint do worker (processo separado da api — mesmo repo, entrypoint diferente).
// Boot: composition root → sobe workers BullMQ (agent-runs + insights-sync) →
// shutdown gracioso. Cron por conta + inbound (webhook) entram nas fatias 3b/5b.

import { Redis } from "ioredis";
import { buildComposition, loadConfig } from "./composition.js";
import { startAgentRunsWorker } from "./workers/agent-runs.js";
import { startAgentCronDispatchWorker } from "./workers/agent-cron-dispatch.js";
import { startInsightsSyncWorker } from "./workers/insights-sync.js";
import { makeAccountCron } from "./schedulers/account-cron.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await buildComposition();
  const { logger } = deps;

  // conexão Redis dedicada aos workers (BullMQ exige maxRetriesPerRequest=null)
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  // 3a: loop de análise read-only (agent-runs) + sync de insights (2a).
  // 3b: dispatch do cron (cria run por conta no horário) + cadência por conta.
  const agentRuns = startAgentRunsWorker(deps, connection);
  const cronDispatch = startAgentCronDispatchWorker(deps, connection);
  const insightsSync = startInsightsSyncWorker(deps, connection);

  // Sincroniza os schedulers recorrentes a partir dos agentes ativos (idempotente).
  const cron = makeAccountCron(deps);
  await cron.syncAllFromDb().catch((err: unknown) => logger.error({ err }, "cron:sync_all falhou"));
  logger.info("worker up: agent-runs (3a) + cron-dispatch (3b) + insights-sync (2a)");

  // shutdown gracioso (drena jobs em andamento antes de sair)
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await Promise.allSettled([agentRuns.close(), cronDispatch.close(), insightsSync.close()]);
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
