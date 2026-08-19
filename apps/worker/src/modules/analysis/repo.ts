// Repositório do run de análise (casca, org-scoped). CRUD via Drizzle direto
// (VSA — sem porta p/ o próprio banco). Os nós do grafo ficam finos: só chamam
// estas funções + o core puro.

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@trafego/db/client";
import { adAccounts, agentMemory, agentRunSteps, agentRuns, agents, platformConnections, playbookRules, recommendations } from "@trafego/db";
import type { Action, AgentGoals, EncryptedPayload, PlaybookRule, RiskLevel } from "@trafego/shared";

export interface AgentContext {
  readonly goals: AgentGoals;
  readonly archetype: string;
  readonly systemPrompt: string | null;
  readonly modelConfig: Readonly<Record<string, unknown>>;
  readonly playbook: PlaybookRule[];
  /** memória "rejeitado" ativa (loop de feedback barato — não repetir o que o dono vetou). */
  readonly rejectedMemory: string[];
}

/** Passo do grafo (trilha p/ a Timeline 6a). */
export interface StepInput {
  readonly runId: string;
  readonly name: string;
  readonly status: "succeeded" | "failed";
  readonly output?: Record<string, unknown>;
  readonly error?: string;
}

export interface AccountCredentials {
  readonly metaAdAccountId: string;
  readonly name: string;
  readonly currency: string;
  readonly tokenCripto: EncryptedPayload;
}

export interface RecommendationRow {
  readonly orgId: string;
  readonly runId: string;
  readonly title: string;
  readonly rationale: string;
  readonly proposedAction: Action | null;
  readonly riskLevel: RiskLevel;
}

export interface CloseRunInput {
  readonly status: "succeeded" | "failed";
  readonly summary: string | null;
  readonly partial: boolean;
  readonly tokenUsage: Record<string, unknown> | null;
  readonly costSnapshot: number | null;
  readonly metricsSnapshot?: Record<string, unknown> | null;
}

export interface AnalysisRepo {
  loadAgentContext(orgId: string, agentId: string): Promise<AgentContext | null>;
  loadAccount(orgId: string, adAccountUuid: string): Promise<AccountCredentials | null>;
  openRun(orgId: string, runId: string, configSnapshot: Record<string, unknown>): Promise<void>;
  markTokenInvalid(orgId: string, adAccountUuid: string): Promise<void>;
  saveRecommendations(rows: readonly RecommendationRow[]): Promise<void>;
  recordStep(input: StepInput): Promise<void>;
  closeRun(orgId: string, runId: string, input: CloseRunInput): Promise<void>;
}

export function createAnalysisRepo(db: Database): AnalysisRepo {
  return {
    async loadAgentContext(orgId, agentId) {
      const [agent] = await db
        .select({
          goals: agents.goals,
          archetype: agents.archetype,
          systemPrompt: agents.systemPrompt,
          modelConfig: agents.modelConfig,
        })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
        .limit(1);
      if (!agent) return null;

      const rules = await db
        .select()
        .from(playbookRules)
        .where(
          and(
            eq(playbookRules.agentId, agentId),
            eq(playbookRules.orgId, orgId),
            eq(playbookRules.enabled, true),
          ),
        );
      const playbook: PlaybookRule[] = rules.map((r) => ({
        id: r.id,
        enabled: r.enabled,
        priority: r.priority,
        scope: r.scope as PlaybookRule["scope"],
        when: r.whenJson,
        then: r.thenJson,
      }));
      // memória "rejeitado" ativa → alimenta o brief (não repetir o que o dono vetou).
      const memory = await db
        .select({ content: agentMemory.content })
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.agentId, agentId),
            eq(agentMemory.orgId, orgId),
            eq(agentMemory.type, "rejected"),
            eq(agentMemory.lifecycle, "active"),
          ),
        );
      return {
        goals: agent.goals,
        archetype: agent.archetype,
        systemPrompt: agent.systemPrompt,
        modelConfig: agent.modelConfig ?? {},
        playbook,
        rejectedMemory: memory.map((m) => m.content),
      };
    },

    async loadAccount(orgId, adAccountUuid) {
      // Token vem da CONEXÃO dona (fonte da verdade); cai no legado da conta se
      // ainda não houver conexão (contas pré-migração — o backfill preenche).
      const [row] = await db
        .select({
          metaAdAccountId: adAccounts.adAccountId,
          name: adAccounts.name,
          currency: adAccounts.currency,
          accountToken: adAccounts.tokenCripto,
          connToken: platformConnections.tokenCripto,
        })
        .from(adAccounts)
        .leftJoin(platformConnections, eq(adAccounts.connectionId, platformConnections.id))
        .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)))
        .limit(1);
      if (!row) return null;
      return {
        metaAdAccountId: row.metaAdAccountId,
        name: row.name ?? row.metaAdAccountId,
        currency: row.currency ?? "BRL",
        tokenCripto: row.connToken ?? row.accountToken,
      };
    },

    async openRun(orgId, runId, configSnapshot) {
      await db
        .update(agentRuns)
        .set({ status: "running", startedAt: sql`now()`, configSnapshot, updatedAt: sql`now()` })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
    },

    async markTokenInvalid(orgId, adAccountUuid) {
      // Marca inválido na CONEXÃO dona (recolar 1x recupera todas as contas dela);
      // conta legada sem conexão cai no status da própria conta.
      const [account] = await db
        .select({ connectionId: adAccounts.connectionId })
        .from(adAccounts)
        .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)))
        .limit(1);
      if (account?.connectionId) {
        await db
          .update(platformConnections)
          .set({ tokenStatus: "invalid", updatedAt: sql`now()` })
          .where(
            and(
              eq(platformConnections.id, account.connectionId),
              eq(platformConnections.orgId, orgId),
            ),
          );
        return;
      }
      await db
        .update(adAccounts)
        .set({ tokenStatus: "invalid", updatedAt: sql`now()` })
        .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)));
    },

    async saveRecommendations(rows) {
      if (rows.length === 0) return;
      // NOTA: insert não-idempotente. Na 3a cada trigger cria um runId novo e o job
      // não re-tenta (attempts=1; AnalysisError fecha o run failed sem rethrow), então
      // não duplica. Recuperação de job travado (re-entrega do MESMO runId) duplicaria
      // linhas — Fatia 5a fecha com delete-by-runId antes do insert (recommendations
      // viram base de ações), quando idempotência de escrita passa a ser obrigatória (§8).
      await db.insert(recommendations).values(
        rows.map((r) => ({
          orgId: r.orgId,
          runId: r.runId,
          title: r.title,
          rationale: r.rationale,
          proposedAction: r.proposedAction ?? null,
          riskLevel: r.riskLevel,
        })),
      );
    },

    async recordStep(input) {
      await db.insert(agentRunSteps).values({
        runId: input.runId,
        name: input.name,
        status: input.status,
        ...(input.output ? { output: input.output } : {}),
        ...(input.error ? { error: input.error } : {}),
      });
    },

    async closeRun(orgId, runId, input) {
      await db
        .update(agentRuns)
        .set({
          status: input.status,
          summary: input.summary,
          partial: input.partial,
          tokenUsage: input.tokenUsage ?? null,
          costSnapshot: input.costSnapshot === null ? null : String(input.costSnapshot),
          ...(input.metricsSnapshot !== undefined ? { metricsSnapshot: input.metricsSnapshot } : {}),
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
    },
  };
}
