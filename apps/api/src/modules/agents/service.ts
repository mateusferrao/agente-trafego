import { and, eq, sql } from "drizzle-orm";
import { adAccounts, agents, agentMutedEntities, type Database } from "@trafego/db";
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
      .select({ id: agents.id, archetype: agents.archetype, goals: agents.goals, status: agents.status })
      .from(agents)
      .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId)))
      .limit(1);
    if (existing) {
      return {
        agentId: existing.id,
        archetype: existing.archetype,
        goals: existing.goals,
        paused: existing.status === "paused",
      };
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
        // ativo ao ser criado → o cron passa a cuidar da conta (pausável pelo dono).
        status: "active",
      })
      .returning({ id: agents.id });
    if (!row) throw notFound("Falha ao criar o agente.");
    return { agentId: row.id, archetype: defaults.key, goals: defaults.goals, paused: false };
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

  /** Pausa/retoma as análises automáticas (freio self-service do beta — §8 kill-switch). */
  async function setPaused(orgId: OrgId, accountId: string, paused: boolean): Promise<AgentSummary> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    await deps.db
      .update(agents)
      .set({ status: paused ? "paused" : "active", updatedAt: sql`now()` })
      .where(and(eq(agents.id, summary.agentId), eq(agents.orgId, orgId)));
    return { ...summary, paused };
  }

  /** Ids das campanhas silenciadas de um agente já resolvido (org-scoped). */
  async function mutedCampaignsForAgent(orgId: OrgId, agentId: string): Promise<string[]> {
    const rows = await deps.db
      .select({ externalId: agentMutedEntities.externalId })
      .from(agentMutedEntities)
      .where(
        and(
          eq(agentMutedEntities.agentId, agentId),
          eq(agentMutedEntities.orgId, orgId),
          eq(agentMutedEntities.entityLevel, "campaign"),
        ),
      );
    return rows.map((r) => r.externalId);
  }

  /** Lista os ids de campanhas silenciadas da conta (org-scoped). */
  async function listMutedCampaigns(orgId: OrgId, accountId: string): Promise<string[]> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    return mutedCampaignsForAgent(orgId, summary.agentId);
  }

  /** Silencia uma campanha (idempotente — não duplica). Devolve a lista atualizada. */
  async function muteCampaign(orgId: OrgId, accountId: string, externalId: string): Promise<string[]> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    await deps.db
      .insert(agentMutedEntities)
      .values({ orgId, agentId: summary.agentId, entityLevel: "campaign", externalId })
      .onConflictDoNothing();
    return mutedCampaignsForAgent(orgId, summary.agentId);
  }

  /** Reativa uma campanha silenciada (remove a linha). Devolve a lista atualizada. */
  async function unmuteCampaign(orgId: OrgId, accountId: string, externalId: string): Promise<string[]> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    await deps.db
      .delete(agentMutedEntities)
      .where(
        and(
          eq(agentMutedEntities.agentId, summary.agentId),
          eq(agentMutedEntities.orgId, orgId),
          eq(agentMutedEntities.entityLevel, "campaign"),
          eq(agentMutedEntities.externalId, externalId),
        ),
      );
    return mutedCampaignsForAgent(orgId, summary.agentId);
  }

  return { getOrCreateForAccount, updateGoals, setPaused, listMutedCampaigns, muteCampaign, unmuteCampaign };
}
