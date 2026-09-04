// Fonte ÚNICA da habilitação de tools no worker (A2): lê agent_tool_bindings + allowedActions e
// resolve as tool-keys habilitadas (as 6) via o resolver puro do core. Os DOIS gates (chat e apply)
// consomem daqui → consistência garantida (o mapa alertou: gates em fontes diferentes divergem).
// Binding ausente → fallback preserva o comportamento atual (4 = allowedActions; criação = default-on).

import { and, eq } from "drizzle-orm";
import { agentToolBindings, guardrailConfigs } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import { resolveEnabledTools } from "@trafego/core";
import { enabledActionTypes, type ToolBindingMode } from "@trafego/shared";

/**
 * Resolve as tool-keys HABILITADAS (as 6) do agente, org-scoped. `allowedActionsFallback` pode
 * vir do chamador que JÁ carregou a linha de guardrail (evita o round-trip extra); omitido → lê.
 */
export async function loadEnabledTools(
  db: Database,
  orgId: string,
  agentId: string,
  allowedActionsFallback?: readonly string[],
): Promise<Set<string>> {
  let fallback = allowedActionsFallback;
  if (fallback === undefined) {
    const [g] = await db
      .select({ allowedActions: guardrailConfigs.allowedActions })
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
      .limit(1);
    fallback = (g?.allowedActions ?? []) as string[];
  }
  const bindings = await db
    .select({ toolKey: agentToolBindings.toolKey, mode: agentToolBindings.mode })
    .from(agentToolBindings)
    .where(and(eq(agentToolBindings.agentId, agentId), eq(agentToolBindings.orgId, orgId)));
  const map = new Map<string, ToolBindingMode>(bindings.map((b) => [b.toolKey, b.mode as ToolBindingMode]));
  return resolveEnabledTools(map, new Set(fallback));
}

/** Re-export da fonte única (`@trafego/shared`) — consumidores do worker seguem importando daqui. */
export { enabledActionTypes } from "@trafego/shared";
