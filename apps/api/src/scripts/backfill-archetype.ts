/**
 * Backfill ONE-TIME do rename de arquétipo (pivô B2B/B2C): o preset
 * `guardiao_lancamento` foi generalizado para `vigia_intensivo` (mesmo
 * comportamento). Agentes semeados com a chave antiga cairiam no fallback
 * `conservador` (`archetypeDefaults`), perdendo cadência/postura/notify.
 *
 * IDEMPOTENTE: só toca linhas com a chave EXATA antiga; rerun não faz nada.
 * Uso:
 *   pnpm backfill:archetype
 */
import { eq, sql } from "drizzle-orm";
import { createDb, agents } from "@trafego/db";
import { loadEnv } from "@trafego/config";

const OLD_KEY = "guardiao_lancamento";
const NEW_KEY = "vigia_intensivo";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const migrated = await db
    .update(agents)
    .set({ archetype: NEW_KEY, updatedAt: sql`now()` })
    .where(eq(agents.archetype, OLD_KEY))
    .returning({ id: agents.id });
  console.log(`✓ agentes migrados ${OLD_KEY} -> ${NEW_KEY}: ${migrated.length}`);

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("falha no backfill:", err);
  process.exit(1);
});
