/**
 * Sincroniza o catálogo GLOBAL de tools (`agent_tool_definitions`) a partir da FONTE ÚNICA
 * `AGENT_TOOL_CATALOG` (tool-catalog.ts). Idempotente (upsert por key) — reusado no boot da api
 * (logo após as migrations, como o backfill) e no CLI de seed. A FK
 * `agent_tool_bindings.tool_key → agent_tool_definitions.key` exige isto semeado antes de qualquer
 * save de binding; rodar em todo deploy mantém o catálogo em dia sem passo manual.
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { agentToolDefinitions } from "./schema/index.js";
import { AGENT_TOOL_CATALOG } from "./tool-catalog.js";

/** Aplica o catálogo (upsert) e fecha a conexão. Seguro chamar toda vez. Retorna quantas tools. */
export async function syncToolCatalog(databaseUrl: string): Promise<{ count: number }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const db = drizzle(pool, { casing: "snake_case" });
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
    return { count: AGENT_TOOL_CATALOG.length };
  } finally {
    await pool.end();
  }
}
