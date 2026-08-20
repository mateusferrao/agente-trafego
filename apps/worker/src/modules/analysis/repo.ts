// Repositório do run de análise (casca, org-scoped). CRUD via Drizzle direto
// (VSA — sem porta p/ o próprio banco). Os nós do grafo ficam finos: só chamam
// estas funções + o core puro.

import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "@trafego/db/client";
import { adAccounts, agentMemory, agentMutedEntities, agentRunSteps, agentRuns, agentToolCalls, agents, conversionLabels, guardrailConfigs, platformConnections, playbookRules, recommendations } from "@trafego/db";
import type { Action, AgentGoals, AutonomyPolicy, ConversionGoal, EncryptedPayload, GuardrailConfig, PlaybookRule, RiskLevel } from "@trafego/shared";
import { unseedIdentity } from "@trafego/core";
import { markConnectionTokenInvalid } from "../../lib/mark-token-invalid.js";

export interface AgentContext {
  readonly goals: AgentGoals;
  readonly archetype: string;
  readonly systemPrompt: string | null;
  /** Identidade/voz (Fatia 4) — compõem o prompt-base (persona + tom). */
  readonly persona: string | null;
  readonly tone: string | null;
  /** Contexto do negócio (fatos) — camada aditiva no prompt (Fatia 4). */
  readonly businessContext: string | null;
  /** Orientações de comportamento — camada aditiva no prompt (Fatia 4). */
  readonly guidance: string | null;
  /** Quando a config relevante à análise mudou — força 1 deep run (Fatia 4). */
  readonly configChangedAt: Date | null;
  readonly modelConfig: Readonly<Record<string, unknown>>;
  /** Autonomia por origem (playbook×llm) — decisão de auto-aplicar × pedir OK (5a). */
  readonly autonomyPolicy: AutonomyPolicy;
  /** Guardrails (rede independente) — blast radius, cap, kill-switch, dry-run (5a). */
  readonly guardrailConfig: GuardrailConfig;
  readonly playbook: PlaybookRule[];
  /** memória "rejeitado" ativa (loop de feedback barato — não repetir o que o dono vetou). */
  readonly rejectedMemory: string[];
  /** ids externos de campanhas silenciadas pelo usuário — excluídas da análise (S5). */
  readonly mutedCampaignIds: string[];
}

/** Rótulo legível de uma conversão (id personalizada "" quando padrão) — Fatia 4. */
export interface ConversionLabelRow {
  readonly goal: ConversionGoal;
  readonly customConversionId: string;
  readonly label: string;
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
  /** Upsert dos rótulos de conversão resolvidos no run (id→nome), p/ a config ler do banco. */
  saveConversionLabels(
    orgId: string,
    adAccountUuid: string,
    platform: string,
    labels: readonly ConversionLabelRow[],
  ): Promise<void>;
  /**
   * Consome o marcador `config_changed_at` (one-shot): zera se ainda for ≤ o valor
   * observado no início do run — assim UM deep basta, independente de quantas
   * unidades foram reanalisadas; um save NOVO durante o run (timestamp maior) sobrevive.
   */
  consumeConfigChanged(orgId: string, agentId: string, observed: Date): Promise<void>;
  recordStep(input: StepInput): Promise<void>;
  closeRun(orgId: string, runId: string, input: CloseRunInput): Promise<void>;
}

/** Defaults conservadores dos guardrails (espelham os defaults de coluna do schema). */
const GUARDRAIL_DEFAULTS: GuardrailConfig = {
  maxBudgetChangePct: 20,
  maxEntitiesPerDay: 3,
  allowedActions: ["pause_entity"],
  dryRun: true,
  killSwitch: false,
};

/** Linha `guardrail_configs` → `GuardrailConfig` (domínio). Ausente → defaults. */
function toGuardrailConfig(row: {
  maxBudgetChangePct: number;
  maxEntitiesPerDay: number;
  allowedActions: GuardrailConfig["allowedActions"];
  dryRun: boolean;
  killSwitch: boolean;
  llmCostCap: string | null;
} | undefined): GuardrailConfig {
  if (!row) return GUARDRAIL_DEFAULTS;
  return {
    maxBudgetChangePct: row.maxBudgetChangePct,
    maxEntitiesPerDay: row.maxEntitiesPerDay,
    allowedActions: row.allowedActions,
    dryRun: row.dryRun,
    killSwitch: row.killSwitch,
    ...(row.llmCostCap !== null ? { llmCostCapUsd: Number(row.llmCostCap) } : {}),
  };
}

export function createAnalysisRepo(db: Database): AnalysisRepo {
  return {
    async loadAgentContext(orgId, agentId) {
      const [agent] = await db
        .select({
          goals: agents.goals,
          archetype: agents.archetype,
          systemPrompt: agents.systemPrompt,
          persona: agents.persona,
          tone: agents.tone,
          businessContext: agents.businessContext,
          guidance: agents.guidance,
          configChangedAt: agents.configChangedAt,
          modelConfig: agents.modelConfig,
          autonomyPolicy: agents.autonomyPolicy,
        })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
        .limit(1);
      if (!agent) return null;

      // Guardrails (rede independente) — linha própria; fallback conservador se ainda
      // não semeada (agentes pré-Fatia-4). Só morde na escrita (5a); lida agora p/ o
      // state carregar valor real e de-riscar a 5a.
      const [guardrailRow] = await db
        .select()
        .from(guardrailConfigs)
        .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
        .limit(1);
      const guardrailConfig = toGuardrailConfig(guardrailRow);

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
      // campanhas silenciadas pelo usuário (opt-out) → excluídas da análise (S5).
      const muted = await db
        .select({ externalId: agentMutedEntities.externalId })
        .from(agentMutedEntities)
        .where(
          and(
            eq(agentMutedEntities.agentId, agentId),
            eq(agentMutedEntities.orgId, orgId),
            eq(agentMutedEntities.entityLevel, "campaign"),
          ),
        );
      return {
        goals: agent.goals,
        archetype: agent.archetype,
        // valor semeado igual ao default do arquétipo = "não configurado" (null) →
        // usa a metodologia composta completa (não o systemPrompt cru semeado).
        systemPrompt: unseedIdentity("systemPrompt", agent.systemPrompt, agent.archetype),
        persona: unseedIdentity("persona", agent.persona, agent.archetype),
        tone: unseedIdentity("tone", agent.tone, agent.archetype),
        businessContext: agent.businessContext,
        guidance: agent.guidance,
        configChangedAt: agent.configChangedAt,
        modelConfig: agent.modelConfig ?? {},
        autonomyPolicy: agent.autonomyPolicy,
        guardrailConfig,
        playbook,
        rejectedMemory: memory.map((m) => m.content),
        mutedCampaignIds: muted.map((m) => m.externalId),
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
        // join reafirma a org na conexão (defense-in-depth no caminho do token).
        .leftJoin(
          platformConnections,
          and(
            eq(adAccounts.connectionId, platformConnections.id),
            eq(platformConnections.orgId, adAccounts.orgId),
          ),
        )
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
      // lógica em helper compartilhado (mesma usada pelo insights-sync).
      await markConnectionTokenInvalid(db, orgId, adAccountUuid);
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

    async saveConversionLabels(orgId, adAccountUuid, platform, labels) {
      if (labels.length === 0) return;
      // upsert por (conta, goal, customConversionId) — nome mais recente vence
      // (o cliente pode renomear a conversão na plataforma).
      await db
        .insert(conversionLabels)
        .values(
          labels.map((l) => ({
            orgId,
            adAccountId: adAccountUuid,
            platform,
            goal: l.goal,
            customConversionId: l.customConversionId,
            label: l.label,
          })),
        )
        .onConflictDoUpdate({
          target: [conversionLabels.adAccountId, conversionLabels.goal, conversionLabels.customConversionId],
          set: { label: sql`excluded.label`, platform: sql`excluded.platform`, updatedAt: sql`now()` },
        });
    },

    async consumeConfigChanged(orgId, agentId, observed) {
      await db
        .update(agents)
        .set({ configChangedAt: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.orgId, orgId),
            lte(agents.configChangedAt, observed),
          ),
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

/** Contexto cross-run do guardrail: o que este agente já aplicou nas últimas 24h. */
export interface DailyToolContext {
  /** `${level}:${id}` tocados por ações REAIS (não simuladas) hoje. */
  readonly touchedToday: Set<string>;
  /** `${level}:${id}` cujo budget mudou hoje (anti-compounding). */
  readonly budgetChangedToday: Set<string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BUDGET_TOOL_KEY = "adjust_budget";

/**
 * Lê os `agent_tool_calls` REAIS (não `dryRun`) deste agente nas últimas 24h e monta
 * o contexto cross-run do guardrail (cap de entidades/dia + anti-compounding de budget).
 * Janela rolante de 24h (mais segura que "meia-noite" e sem depender de fuso). Org-scoped
 * via join no run (que é org-scoped).
 */
export async function loadDailyToolContext(
  db: Database,
  agentId: string,
  now: Date = new Date(),
): Promise<DailyToolContext> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await db
    .select({ toolKey: agentToolCalls.toolKey, args: agentToolCalls.args })
    .from(agentToolCalls)
    .innerJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
    .where(and(eq(agentRuns.agentId, agentId), gte(agentToolCalls.createdAt, since)));

  const touchedToday = new Set<string>();
  const budgetChangedToday = new Set<string>();
  for (const r of rows) {
    const args = r.args as { target?: { level: string; id: string }; dryRun?: boolean };
    if (args?.dryRun || !args?.target) continue; // simulado não conta
    const key = `${args.target.level}:${args.target.id}`;
    touchedToday.add(key);
    if (r.toolKey === BUDGET_TOOL_KEY) budgetChangedToday.add(key);
  }
  return { touchedToday, budgetChangedToday };
}
