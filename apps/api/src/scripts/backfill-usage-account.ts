/**
 * Backfill ONE-TIME (Fatia 6c) da atribuição de custo por conta: preenche
 * `usage_events.ad_account_id` nas linhas de RUN antigas (chat já grava direto),
 * derivando a conta via run → agente → ad_account.
 *
 * IDEMPOTENTE: só toca linhas com `ad_account_id IS NULL` e `run_id` presente —
 * re-executar não muda nada. Chat sem run (run_id null) segue org-only. Uso:
 *   pnpm backfill:usage-account
 */
import { sql } from "drizzle-orm";
import { createDb } from "@trafego/db";
import { loadEnv } from "@trafego/config";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const result = await db.execute(sql`
    UPDATE usage_events ue
    SET ad_account_id = a.ad_account_id
    FROM agent_runs r
    JOIN agents a ON a.id = r.agent_id
    WHERE ue.run_id = r.id
      AND ue.ad_account_id IS NULL
  `);
  const count = (result as { rowCount?: number }).rowCount ?? 0;
  console.log(`✓ usage_events atribuídos a conta (backfill via run→agente): ${count}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("falha no backfill:", err);
  process.exit(1);
});
