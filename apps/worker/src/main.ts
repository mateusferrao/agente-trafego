// Entrypoint do worker (processo separado da api — mesmo repo, entrypoint diferente).
// Boot: composition root → sobe workers BullMQ (agent-runs + insights-sync) →
// shutdown gracioso. Cron por conta + inbound (webhook) entram nas fatias 3b/5b.

import { Redis } from "ioredis";
import { buildComposition, loadConfig } from "./composition.js";
import { startAgentRunsWorker } from "./workers/agent-runs.js";
import { startInsightsSyncWorker } from "./workers/insights-sync.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await buildComposition();
  const { logger } = deps;

  // conexão Redis dedicada aos workers (BullMQ exige maxRetriesPerRequest=null)
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  // 3a: loop de análise read-only (agent-runs) + sync de insights (2a).
  const agentRuns = startAgentRunsWorker(deps, connection);
  const insightsSync = startInsightsSyncWorker(deps, connection);
  logger.info("worker up: agent-runs (fatia 3a) + insights-sync (fatia 2a)");

  // shutdown gracioso (drena jobs em andamento antes de sair)
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await Promise.allSettled([agentRuns.close(), insightsSync.close()]);
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
