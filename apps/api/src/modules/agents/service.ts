import { and, eq, sql } from "drizzle-orm";
import { adAccounts, agents, type Database } from "@trafego/db";
import { archetypeDefaults, DEFAULT_ARCHETYPE_KEY } from "@trafego/core";
import type { AgentGoals, OrgId } from "@trafego/shared/types";
import { notFound } from "../../middleware/error-handler.js";
import type { AgentGoalsInput, AgentSummary } from "./schema.js";

export interface AgentsDeps {
  readonly db: Database;
}

/**
 * Slice de agentes (3a mínimo): garante o agente default por conta (zero-config,
 * criação lazy pelo arquétipo `conservador`) e edita a META (target CPA/ROAS).
 * A superfície completa de config = Fatia 4.
 */
export function createAgentsService(deps: AgentsDeps) {
  /**
   * Garante 1 agente p/ a conta (org-scoped). Não existe → cria com os defaults
   * do arquétipo default (fonte única em @trafego/core). Idempotente.
   */
  async function getOrCreateForAccount(orgId: OrgId, accountId: string): Promise<AgentSummary> {
    const [account] = await deps.db
      .select({ id: adAccounts.id })
      .from(adAccounts)
      .where(and(eq(adAccounts.id, accountId), eq(adAccounts.orgId, orgId)))
      .limit(1);
    if (!account) throw notFound("Conta não encontrada.");

    const [existing] = await deps.db
      .select({ id: agents.id, archetype: agents.archetype, goals: agents.goals })
      .from(agents)
      .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId)))
      .limit(1);
    if (existing) {
      return { agentId: existing.id, archetype: existing.archetype, goals: existing.goals };
    }

    const defaults = archetypeDefaults(DEFAULT_ARCHETYPE_KEY);
    const [row] = await deps.db
      .insert(agents)
      .values({
        orgId,
        adAccountId: accountId,
        archetype: defaults.key,
        persona: defaults.persona,
        systemPrompt: defaults.systemPrompt,
        tone: defaults.tone,
        goals: defaults.goals,
        autonomyPolicy: defaults.autonomyPolicy,
      })
      .returning({ id: agents.id });
    if (!row) throw notFound("Falha ao criar o agente.");
    return { agentId: row.id, archetype: defaults.key, goals: defaults.goals };
  }

  /** Atualiza a meta do agente (cria se necessário) — org-scoped. */
  async function updateGoals(
    orgId: OrgId,
    accountId: string,
    goals: AgentGoalsInput,
  ): Promise<AgentSummary> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    // exactOptionalPropertyTypes: só inclui a chave quando definida (sem `undefined`).
    const nextGoals: AgentGoals = {
      ...(goals.targetCPA !== undefined ? { targetCPA: goals.targetCPA } : {}),
      ...(goals.targetROAS !== undefined ? { targetROAS: goals.targetROAS } : {}),
    };
    await deps.db
      .update(agents)
      .set({ goals: nextGoals, updatedAt: sql`now()` })
      .where(and(eq(agents.id, summary.agentId), eq(agents.orgId, orgId)));
    return { ...summary, goals: nextGoals };
  }

  return { getOrCreateForAccount, updateGoals };
}
