/**
 * Backfill ONE-TIME do gate de beta (6b) — grandfather dos dados pré-6b:
 *   - users criados ANTES do cutoff sem email_verified_at → verificados
 *   - access_grants criados ANTES do cutoff `pending` → `active`
 *
 * O **cutoff** (`--before=<ISO>` = instante do deploy da 6b) torna a re-execução
 * INÓCUA: signups/grants criados DEPOIS nunca são tocados (sem o cutoff, um rerun
 * pós-beta auto-liberaria contas ainda em análise — footgun). Uso:
 *   tsx --env-file=.env apps/api/src/scripts/backfill-access.ts --before=2026-08-21T00:00:00Z
 */
import { and, isNull, eq, lt, sql } from "drizzle-orm";
import { createDb, users, accessGrants } from "@trafego/db";
import { loadEnv } from "@trafego/config";

function parseCutoff(): Date {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--before="));
  const raw = arg?.slice("--before=".length);
  const cutoff = raw ? new Date(raw) : new Date(NaN);
  if (!raw || Number.isNaN(cutoff.getTime())) {
    console.error(
      "cutoff obrigatório. Rode com o instante do deploy da 6b:\n" +
        "  pnpm backfill:access -- --before=2026-08-21T00:00:00Z\n" +
        "(o cutoff torna a re-execução inócua — só grandfather de dados anteriores a ele)",
    );
    process.exit(1);
  }
  return cutoff;
}

async function main(): Promise<void> {
  const cutoff = parseCutoff();
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const verified = await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(and(isNull(users.emailVerifiedAt), lt(users.createdAt, cutoff)))
    .returning({ id: users.id });
  console.log(`✓ users verificados (grandfather, < ${cutoff.toISOString()}): ${verified.length}`);

  const activated = await db
    .update(accessGrants)
    .set({ status: "active", activatedAt: new Date(), updatedAt: sql`now()` })
    .where(and(eq(accessGrants.status, "pending"), lt(accessGrants.createdAt, cutoff)))
    .returning({ email: accessGrants.email });
  console.log(`✓ grants ativados (grandfather, < ${cutoff.toISOString()}): ${activated.length}`);

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("falha no backfill:", err);
  process.exit(1);
});
