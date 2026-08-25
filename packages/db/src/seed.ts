/**
 * Seed idempotente. Fatia 0: garante a org beta (slug fixo). Rodar N vezes =
 * 1 org (upsert por slug). Script standalone — lê DATABASE_URL direto (não é o
 * boot da app; não força o env completo do @trafego/config).
 */
import { BETA_ORG_NAME, BETA_ORG_SLUG } from "./constants.js";
import { createDb } from "./client.js";
import { agentToolDefinitions, orgs } from "./schema/index.js";
import { AGENT_TOOL_CATALOG } from "./tool-catalog.js";
import { eq } from "drizzle-orm";

async function seed(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL não definida — exporte antes de rodar o seed.");
  }
  const db = createDb(url);

  await db
    .insert(orgs)
    .values({ name: BETA_ORG_NAME, slug: BETA_ORG_SLUG })
    .onConflictDoNothing({ target: orgs.slug });

  const [org] = await db.select().from(orgs).where(eq(orgs.slug, BETA_ORG_SLUG)).limit(1);

  // catálogo de tools de escrita (global). Upsert por key → re-seed reflete mudanças
  // de description/riskLevel no tool-catalog.
  for (const tool of AGENT_TOOL_CATALOG) {
    await db
      .insert(agentToolDefinitions)
      .values(tool)
      .onConflictDoUpdate({
        target: agentToolDefinitions.key,
        set: {
          description: tool.description,
          riskLevel: tool.riskLevel,
          isIdempotent: tool.isIdempotent,
          requiredPermission: tool.requiredPermission,
          executableInChat: tool.executableInChat,
          proposable: tool.proposable,
          approvalPolicy: tool.approvalPolicy,
        },
      });
  }

  // eslint-disable-next-line no-console -- script de linha de comando
  console.log(`seed ok: org beta = ${org?.id ?? "(não encontrada)"} · ${AGENT_TOOL_CATALOG.length} tools`);
}

seed()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console -- script de linha de comando
    console.error("seed falhou:", err);
    process.exit(1);
  });
