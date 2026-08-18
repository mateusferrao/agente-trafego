// Entrypoint do worker (processo separado da api — mesmo repo, entrypoint diferente).
// Boot: composition root → sincroniza schedulers por conta → sobe workers BullMQ
// (agent-runs + webhook-inbound) → shutdown gracioso.

import { Redis } from "ioredis";
import { buildComposition, loadConfig } from "./composition.js";
import { startFatia0Worker } from "./workers/fatia0-run.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await buildComposition();
  const { logger } = deps;

  // conexão Redis dedicada aos workers (BullMQ exige maxRetriesPerRequest=null)
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  // Fatia 0: só o worker mínimo (analysis-run). Grafo (agent-runs) + inbound
  // (webhook-inbound) + schedulers cron entram nas fatias 3a/5b/3b.
  const fatia0 = startFatia0Worker(deps, connection);
  logger.info("worker up: analysis-run (fatia 0)");

  // shutdown gracioso (drena jobs em andamento antes de sair)
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await Promise.allSettled([fatia0.close()]);
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
