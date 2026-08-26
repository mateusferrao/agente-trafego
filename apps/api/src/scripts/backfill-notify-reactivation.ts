/**
 * Backfill ONE-TIME (pivô): adiciona `reactivation:{enabled:false}` ao
 * `agents.notify_policy` das linhas anteriores ao campo (jsonb não auto-migra).
 * Leitura já é defensiva (default off), mas isto normaliza o dado persistido.
 *
 * IDEMPOTENTE: só toca linhas SEM a chave `reactivation`. Uso:
 *   pnpm backfill:notify-reactivation
 */
import { sql } from "drizzle-orm";
import { createDb, agents } from "@trafego/db";
import { loadEnv } from "@trafego/config";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const patched = await db
    .update(agents)
    .set({
      notifyPolicy: sql`${agents.notifyPolicy} || '{"reactivation":{"enabled":false}}'::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(sql`NOT (${agents.notifyPolicy} ? 'reactivation')`)
    .returning({ id: agents.id });
  console.log(`✓ notify_policy normalizado (reactivation adicionado): ${patched.length}`);

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("falha no backfill:", err);
  process.exit(1);
});
