/**
 * Backfill ONE-TIME do gate de beta (6b) — rode UMA VEZ no deploy da 6b, ANTES de
 * abrir o beta a novos signups reais. Grandfather dos dados pré-6b:
 *   - users existentes sem email_verified_at → verificados (não trancar quem já usava)
 *   - access_grants existentes `pending` → `active`
 *
 * NÃO é idempotente-seguro para re-execução após novos signups (verificaria/ativaria
 * quem deveria ficar pendente). Exige `--confirm`. Uso:
 *   tsx --env-file=.env apps/api/src/scripts/backfill-access.ts --confirm
 */
import { isNull, eq, sql } from "drizzle-orm";
import { createDb, users, accessGrants } from "@trafego/db";
import { loadEnv } from "@trafego/config";

async function main(): Promise<void> {
  if (!process.argv.slice(2).includes("--confirm")) {
    console.error(
      "backfill one-time (grandfather pré-6b). Rode UMA VEZ, antes de abrir o beta.\n" +
        "Confirme com: pnpm backfill:access -- --confirm",
    );
    process.exit(1);
  }
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const verified = await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(isNull(users.emailVerifiedAt))
    .returning({ id: users.id });
  console.log(`✓ users verificados (grandfather): ${verified.length}`);

  const activated = await db
    .update(accessGrants)
    .set({ status: "active", activatedAt: new Date(), updatedAt: sql`now()` })
    .where(eq(accessGrants.status, "pending"))
    .returning({ email: accessGrants.email });
  console.log(`✓ grants ativados (grandfather): ${activated.length}`);

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("falha no backfill:", err);
  process.exit(1);
});
