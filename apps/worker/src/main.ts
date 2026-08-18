// Entrypoint do worker (processo separado da api — mesmo repo, entrypoint diferente).
// Boot: composition root → sincroniza schedulers por conta → sobe workers BullMQ
// (agent-runs + webhook-inbound) → shutdown gracioso.

import IORedis from "ioredis";
import { buildComposition, loadConfig } from "./composition.js";
import { makeAccountCron } from "./schedulers/account-cron.js";
import { startAgentRunsWorker } from "./workers/agent-runs.js";
import { startWebhookInboundWorker } from "./workers/webhook-inbound.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await buildComposition(config);
  const { logger } = deps;

  // conexão Redis dedicada aos workers (BullMQ exige maxRetriesPerRequest=null)
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  // 1) sincroniza os schedulers recorrentes por conta (cadência + jitter)
  const cron = makeAccountCron(deps);
  await cron.syncAllFromDb();

  // 2) sobe os workers (jobs de análise + inbound do WhatsApp)
  const agentRuns = startAgentRunsWorker(deps, connection);
  const webhookInbound = startWebhookInboundWorker(deps, connection);

  logger.info("worker up: agent-runs + webhook-inbound");

  // 3) shutdown gracioso (drena jobs em andamento antes de sair)
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await Promise.allSettled([agentRuns.close(), webhookInbound.close()]);
    await connection.quit();
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
