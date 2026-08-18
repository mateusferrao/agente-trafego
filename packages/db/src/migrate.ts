/**
 * Migrate de PRODUÇÃO — aplica o SQL já gerado em `drizzle/` via o migrator do
 * drizzle-orm (runtime dep). Não usa `drizzle-kit` (devDep) → funciona mesmo com
 * devDeps podadas em prod. Geração do SQL (`db:generate`) segue sendo dev-only.
 */
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL não definida — exporte antes de rodar o migrate.");
  }
  const db = createDb(url);
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
  // eslint-disable-next-line no-console -- script de linha de comando
  console.log("migrate ok");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console -- script de linha de comando
    console.error("migrate falhou:", err);
    process.exit(1);
  });
