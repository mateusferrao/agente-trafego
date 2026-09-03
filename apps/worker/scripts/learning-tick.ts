// Dispara UM tick do loop de aprendizado sob demanda (em vez de esperar o cron das 06:00).
// Só enfileira na fila `agent-learning` — o WORKER precisa estar rodando p/ processar.
// Uso: pnpm learning:tick   (ou: pnpm exec tsx --env-file=.env scripts/learning-tick.ts)
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const queue = new Queue("agent-learning", { connection });
await queue.add("tick", {});
console.log("✓ tick de aprendizado enfileirado (fila agent-learning) — veja o log do worker: agent-learning:tick");
await queue.close();
await connection.quit();
