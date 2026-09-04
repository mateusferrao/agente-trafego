/**
 * CLI do seed CATÁLOGO-ONLY (idempotente) — só o `agent_tool_definitions` global, SEM criar org
 * beta (diferente do seed.ts). Reusa `syncToolCatalog` (mesma sincronização do boot da api). Útil
 * pra semear um banco existente sem esperar o próximo deploy.
 * Rodar: DATABASE_URL=... tsx packages/db/src/seed-tool-catalog.ts
 */
import { syncToolCatalog } from "./sync-tool-catalog.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definida — exporte antes de rodar o seed.");
  const { count } = await syncToolCatalog(url);
  // eslint-disable-next-line no-console -- script de linha de comando
  console.log(`catálogo semeado: ${count} tools`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console -- script de linha de comando
    console.error("seed catálogo falhou:", err);
    process.exit(1);
  });
