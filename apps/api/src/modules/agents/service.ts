import { and, eq, gte, lte, sql } from "drizzle-orm";
import { adAccounts, agents, agentMutedEntities, conversionLabels, insightsSnapshots, type Database } from "@trafego/db";
import { archetypeDefaults, DEFAULT_ARCHETYPE_KEY } from "@trafego/core";
import type { AgentGoals, OrgId, StoredInsightMetrics } from "@trafego/shared/types";
import { badRequest, notFound } from "../../middleware/error-handler.js";
import {
  ANALYSIS_WINDOW_DEFAULT_DAYS,
  ANALYSIS_WINDOW_MAX_DAYS,
  ANALYSIS_WINDOW_MIN_DAYS,
  type AgentConfigInput,
  type AgentGoalsInput,
  type AgentSummary,
  type AvailableConversionsOutput,
} from "./schema.js";

/** Janela recente p/ listar as conversões que a conta reportou (dias). */
const AVAILABLE_CONVERSIONS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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
      .select({
        id: agents.id,
        archetype: agents.archetype,
        goals: agents.goals,
        businessContext: agents.businessContext,
        guidance: agents.guidance,
        modelConfig: agents.modelConfig,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId)))
      .limit(1);
    if (existing) {
      return {
        agentId: existing.id,
        archetype: existing.archetype,
        goals: existing.goals,
        businessContext: existing.businessContext,
        guidance: existing.guidance,
        analysisWindowDays: windowFromModelConfig(existing.modelConfig),
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
    return {
      agentId: row.id,
      archetype: defaults.key,
      goals: defaults.goals,
      businessContext: null,
      guidance: null,
      analysisWindowDays: ANALYSIS_WINDOW_DEFAULT_DAYS,
      paused: false,
    };
  }

  /**
   * Salva a config do agente (Fatia 4 corte 1): meta+conversão de negócio +
   * personalização por texto. Bumpa `config_changed_at` → o próximo run faz 1 deep
   * (a herança incremental do cron não olha config; sem isso, texto novo não refletiria).
   */
  async function updateConfig(
    orgId: OrgId,
    accountId: string,
    input: AgentConfigInput,
  ): Promise<AgentSummary> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    // cleanGoals normaliza os dois casos (input do form ou goals atuais) p/ AgentGoals.
    const nextGoals = cleanGoals(input.goals ?? summary.goals);
    // conversão personalizada exige o id (senão o brief casaria uma custom arbitrária).
    if (nextGoals.conversionGoal === "custom" && !nextGoals.customConversionId) {
      throw badRequest("Escolha qual conversão personalizada usar como resultado do negócio.");
    }
    const nextBusinessContext =
      input.businessContext !== undefined ? trimOrNull(input.businessContext) : summary.businessContext;
    const nextGuidance =
      input.guidance !== undefined ? trimOrNull(input.guidance) : summary.guidance;

    // janela de análise vive no model_config (jsonb) — merge p/ preservar as outras chaves.
    const [row] = await deps.db
      .select({ modelConfig: agents.modelConfig })
      .from(agents)
      .where(and(eq(agents.id, summary.agentId), eq(agents.orgId, orgId)))
      .limit(1);
    const currentModelConfig = row?.modelConfig ?? {};
    const nextWindow = input.analysisWindowDays ?? summary.analysisWindowDays;
    const nextModelConfig = { ...currentModelConfig, windowDays: nextWindow };

    // só força 1 deep (bumpa config_changed_at) quando um campo relevante à análise
    // mudou de fato — evita deep desnecessário em save idêntico (idempotência).
    const runRelevantChanged =
      JSON.stringify(nextGoals) !== JSON.stringify(cleanGoals(summary.goals)) ||
      nextBusinessContext !== (summary.businessContext ?? null) ||
      nextGuidance !== (summary.guidance ?? null) ||
      nextWindow !== summary.analysisWindowDays;

    await deps.db
      .update(agents)
      .set({
        goals: nextGoals,
        businessContext: nextBusinessContext,
        guidance: nextGuidance,
        modelConfig: nextModelConfig,
        ...(runRelevantChanged ? { configChangedAt: sql`now()` } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(agents.id, summary.agentId), eq(agents.orgId, orgId)));
    return {
      ...summary,
      goals: nextGoals,
      businessContext: nextBusinessContext,
      guidance: nextGuidance,
      analysisWindowDays: nextWindow,
    };
  }

  /**
   * Conversões que a conta reportou na janela recente (nível `account` p/ não
   * duplicar entre níveis) + o rótulo legível de `conversion_labels` (nome real da
   * personalizada, quando o worker já resolveu num run). DB-only — sem chamada Meta.
   * Base do select anotado da config; vazio até a conta ter um run (sem snapshot).
   */
  async function availableConversions(
    orgId: OrgId,
    accountId: string,
  ): Promise<AvailableConversionsOutput> {
    const until = new Date();
    const since = new Date(until.getTime() - AVAILABLE_CONVERSIONS_WINDOW_DAYS * DAY_MS);
    const rows = await deps.db
      .select({ metricsJson: insightsSnapshots.metricsJson })
      .from(insightsSnapshots)
      .where(
        and(
          eq(insightsSnapshots.orgId, orgId),
          eq(insightsSnapshots.adAccountId, accountId),
          eq(insightsSnapshots.entityLevel, "account"),
          gte(insightsSnapshots.date, ymd(since)),
          lte(insightsSnapshots.date, ymd(until)),
        ),
      );

    // agrega contagem por (goal, id personalizada) somando os dias da janela.
    const byKey = new Map<string, { goal: string; customConversionId: string; count: number }>();
    for (const r of rows) {
      for (const c of (r.metricsJson as StoredInsightMetrics).conversions ?? []) {
        const customConversionId = c.customConversionId ?? "";
        const key = `${c.goal}:${customConversionId}`;
        const e = byKey.get(key) ?? { goal: c.goal, customConversionId, count: 0 };
        e.count += c.count;
        byKey.set(key, e);
      }
    }

    const labelRows = await deps.db
      .select({
        goal: conversionLabels.goal,
        customConversionId: conversionLabels.customConversionId,
        label: conversionLabels.label,
      })
      .from(conversionLabels)
      .where(and(eq(conversionLabels.orgId, orgId), eq(conversionLabels.adAccountId, accountId)));
    const labelByKey = new Map(labelRows.map((l) => [`${l.goal}:${l.customConversionId}`, l.label]));

    const conversions = [...byKey.values()]
      .sort((a, b) => b.count - a.count)
      .map((e) => {
        const label = labelByKey.get(`${e.goal}:${e.customConversionId}`);
        return {
          goal: e.goal,
          ...(e.customConversionId ? { customConversionId: e.customConversionId } : {}),
          count: e.count,
          ...(label ? { label } : {}),
        };
      });
    return { conversions };
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

  return {
    getOrCreateForAccount,
    updateConfig,
    availableConversions,
    setPaused,
    listMutedCampaigns,
    muteCampaign,
    unmuteCampaign,
  };
}

/** Só as chaves definidas (exactOptionalPropertyTypes — sem gravar `undefined`). */
function cleanGoals(g: AgentGoalsInput): AgentGoals {
  return {
    ...(g.targetCPA !== undefined ? { targetCPA: g.targetCPA } : {}),
    ...(g.targetROAS !== undefined ? { targetROAS: g.targetROAS } : {}),
    ...(g.conversionGoal !== undefined ? { conversionGoal: g.conversionGoal } : {}),
    ...(g.customConversionId !== undefined ? { customConversionId: g.customConversionId } : {}),
  };
}

/** Texto aparado, ou null quando vazio (mantém o DB limpo; "" limpa o campo). */
function trimOrNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/** Data → YYYY-MM-DD (coluna `date` do snapshot). */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Janela salva no model_config (ou o default), capada aos limites — p/ exibir na config. */
function windowFromModelConfig(mc: Readonly<Record<string, unknown>> | null | undefined): number {
  const raw = mc?.windowDays;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return ANALYSIS_WINDOW_DEFAULT_DAYS;
  return Math.min(ANALYSIS_WINDOW_MAX_DAYS, Math.max(ANALYSIS_WINDOW_MIN_DAYS, Math.floor(raw)));
}
