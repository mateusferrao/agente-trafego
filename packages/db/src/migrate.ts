/**
 * Migrations de PRODUÇÃO via migrator do `drizzle-orm` (runtime dep) — aplica o
 * SQL já gerado em `drizzle/`, sem `drizzle-kit`. Idempotente: só aplica o que
 * falta (drizzle rastreia em `__drizzle_migrations`).
 *
 * `runMigrations` é reusado no boot da api (auto-migrate no deploy). O bloco CLI
 * só roda quando o arquivo é executado direto (`tsx migrate.ts`), não em import.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Aplica as migrations pendentes e fecha a conexão. Seguro chamar toda vez. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL não definida — exporte antes de rodar o migrate.");
  }
  await runMigrations(url);
  // eslint-disable-next-line no-console -- script de linha de comando
  console.log("migrate ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console -- script de linha de comando
      console.error("migrate falhou:", err);
      process.exit(1);
    });
}
