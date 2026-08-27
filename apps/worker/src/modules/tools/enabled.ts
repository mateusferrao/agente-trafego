// Fonte ÚNICA da habilitação de tools no worker (A2): lê agent_tool_bindings + allowedActions e
// resolve as tool-keys habilitadas (as 6) via o resolver puro do core. Os DOIS gates (chat e apply)
// consomem daqui → consistência garantida (o mapa alertou: gates em fontes diferentes divergem).
// Binding ausente → fallback preserva o comportamento atual (4 = allowedActions; criação = default-on).

import { and, eq } from "drizzle-orm";
import { agentToolBindings, guardrailConfigs } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import { resolveEnabledTools } from "@trafego/core";
import { WRITE_TOOL_TO_ACTION, type ActionType, type ToolBindingMode } from "@trafego/shared";

/** Resolve as tool-keys HABILITADAS (as 6) do agente, org-scoped. */
export async function loadEnabledTools(db: Database, orgId: string, agentId: string): Promise<Set<string>> {
  const [g] = await db
    .select({ allowedActions: guardrailConfigs.allowedActions })
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
    .limit(1);
  const bindings = await db
    .select({ toolKey: agentToolBindings.toolKey, mode: agentToolBindings.mode })
    .from(agentToolBindings)
    .where(and(eq(agentToolBindings.agentId, agentId), eq(agentToolBindings.orgId, orgId)));
  const map = new Map<string, ToolBindingMode>(bindings.map((b) => [b.toolKey, b.mode as ToolBindingMode]));
  return resolveEnabledTools(map, new Set((g?.allowedActions ?? []) as string[]));
}

/** Subconjunto das ACTION-types habilitadas (das 4) — p/ sobrescrever `cfg.allowedActions` no apply. */
export function enabledActionTypes(enabled: ReadonlySet<string>): ActionType[] {
  return [...WRITE_TOOL_TO_ACTION.entries()].filter(([tool]) => enabled.has(tool)).map(([, action]) => action);
}
