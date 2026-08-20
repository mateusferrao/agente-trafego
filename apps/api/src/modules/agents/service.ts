import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  adAccounts,
  agents,
  agentMutedEntities,
  agentRuns,
  agentToolCalls,
  conversionLabels,
  guardrailConfigs,
  insightsSnapshots,
  playbookRules,
  type Database,
} from "@trafego/db";
import { archetypeDefaults, composeMethodologyPrompt, unseedIdentity, DEFAULT_ARCHETYPE_KEY } from "@trafego/core";
import {
  ACTION_UNDO_QUEUE,
  ACTION_UNDO_JOB,
  SCHEDULE_RESYNC_QUEUE,
  SCHEDULE_RESYNC_JOB,
} from "@trafego/shared";
import type { Action, AgentGoals, OrgId, StoredInsightMetrics } from "@trafego/shared/types";
import type { SchedulerPort } from "@trafego/shared/ports";
import {
  ANALYSIS_WINDOW_DEFAULT_DAYS,
  ANALYSIS_WINDOW_MAX_DAYS,
  ANALYSIS_WINDOW_MIN_DAYS,
} from "@trafego/shared";
import { badRequest, notFound } from "../../middleware/error-handler.js";
import {
  type AgentConfigInput,
  type AgentGoalsInput,
  type AgentSummary,
  type AvailableConversionsOutput,
  type LastRunActionsOutput,
  type PlaybookRuleInput,
  type PlaybookRuleOutput,
} from "./schema.js";
import type { PlaybookCondition } from "@trafego/shared/types";

/** Janela recente p/ listar as conversões que a conta reportou (dias). */
const AVAILABLE_CONVERSIONS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgentsDeps {
  readonly db: Database;
  /** enfileira o resync do schedule (worker = dono do scheduler) ao salvar a cadência. */
  readonly scheduler: SchedulerPort;
}

/**
 * Slice de agentes (3a mínimo): garante o agente default por conta (zero-config,
 * criação lazy pelo arquétipo `conservador`) e edita a META (target CPA/ROAS).
 * A superfície completa de config = Fatia 4.
 */
/** Defaults de guardrail (espelham as colunas do schema) — usado antes do 1º save. */
const GUARDRAIL_DEFAULTS: AgentSummary["guardrails"] = {
  maxBudgetChangePct: 20,
  maxEntitiesPerDay: 3,
  allowedActions: ["pause_entity"],
  dryRun: true,
  killSwitch: false,
};

export function createAgentsService(deps: AgentsDeps) {
  /** Lê a linha `guardrail_configs` → shape do contrato (ausente → defaults). */
  async function loadGuardrails(orgId: OrgId, agentId: string): Promise<AgentSummary["guardrails"]> {
    const [g] = await deps.db
      .select()
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
      .limit(1);
    if (!g) return GUARDRAIL_DEFAULTS;
    return {
      maxBudgetChangePct: g.maxBudgetChangePct,
      maxEntitiesPerDay: g.maxEntitiesPerDay,
      allowedActions: g.allowedActions,
      dryRun: g.dryRun,
      killSwitch: g.killSwitch,
      ...(g.llmCostCap != null ? { llmCostCapUsd: Number(g.llmCostCap) } : {}),
    };
  }

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
        persona: agents.persona,
        tone: agents.tone,
        systemPrompt: agents.systemPrompt,
        cadence: agents.cadence,
        modelConfig: agents.modelConfig,
        autonomyPolicy: agents.autonomyPolicy,
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
        // valor semeado == default do arquétipo → "não configurado" (null), p/ a UI
        // mostrar vazio (usa o arquétipo) e não travar a metodologia.
        persona: unseedIdentity("persona", existing.persona, existing.archetype),
        tone: unseedIdentity("tone", existing.tone, existing.archetype),
        systemPrompt: unseedIdentity("systemPrompt", existing.systemPrompt, existing.archetype),
        cadence: existing.cadence ?? null,
        methodologyPreview: methodologyFor(existing.archetype),
        analysisWindowDays: windowFromModelConfig(existing.modelConfig),
        paused: existing.status === "paused",
        autonomyPolicy: existing.autonomyPolicy,
        guardrails: await loadGuardrails(orgId, existing.id),
      };
    }

    const defaults = archetypeDefaults(DEFAULT_ARCHETYPE_KEY);
    const [row] = await deps.db
      .insert(agents)
      .values({
        orgId,
        adAccountId: accountId,
        archetype: defaults.key,
        // NÃO semeamos persona/tone/systemPrompt: null = "usa o arquétipo" (semântica
        // vazia). Semear travaria a metodologia e mostraria o campo pré-preenchido.
        goals: defaults.goals,
        autonomyPolicy: defaults.autonomyPolicy,
        // ativo ao ser criado → o cron passa a cuidar da conta (pausável pelo dono).
        status: "active",
      })
      .returning({ id: agents.id });
    if (!row) throw notFound("Falha ao criar o agente.");
    // Semeia a linha de guardrails (rede independente) com os defaults de coluna —
    // o worker lê no run (só morde na escrita, 5a). Sem isso o read cairia no fallback.
    await deps.db.insert(guardrailConfigs).values({ orgId, agentId: row.id }).onConflictDoNothing();
    return {
      agentId: row.id,
      archetype: defaults.key,
      goals: defaults.goals,
      businessContext: null,
      guidance: null,
      persona: null,
      tone: null,
      systemPrompt: null,
      cadence: null,
      methodologyPreview: methodologyFor(defaults.key),
      analysisWindowDays: ANALYSIS_WINDOW_DEFAULT_DAYS,
      paused: false,
      autonomyPolicy: defaults.autonomyPolicy,
      guardrails: GUARDRAIL_DEFAULTS,
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
    // identidade/voz (c2): "" limpa (persona/tone vazios) e systemPrompt "" = usa arquétipo.
    const nextPersona = input.persona !== undefined ? trimOrNull(input.persona) : summary.persona;
    const nextTone = input.tone !== undefined ? trimOrNull(input.tone) : summary.tone;
    const nextSystemPrompt =
      input.systemPrompt !== undefined ? trimOrNull(input.systemPrompt) : summary.systemPrompt;
    // cadência (c2): quando enviada, define; senão preserva. null nunca vem do input aqui.
    const nextCadence = input.cadence !== undefined ? input.cadence : summary.cadence;
    const cadenceChanged =
      input.cadence !== undefined &&
      JSON.stringify(input.cadence) !== JSON.stringify(summary.cadence ?? null);

    // janela de análise vive no model_config (jsonb) — merge p/ preservar as outras chaves.
    const [row] = await deps.db
      .select({ modelConfig: agents.modelConfig })
      .from(agents)
      .where(and(eq(agents.id, summary.agentId), eq(agents.orgId, orgId)))
      .limit(1);
    const currentModelConfig = row?.modelConfig ?? {};
    const nextWindow = input.analysisWindowDays ?? summary.analysisWindowDays;
    const nextModelConfig = { ...currentModelConfig, windowDays: nextWindow };
    // autonomia/guardrails (5a): só mordem na ESCRITA — não bumpam config_changed_at
    // (não alteram o brief/análise). Persistidos direto.
    const nextAutonomy = input.autonomyPolicy ?? summary.autonomyPolicy;
    const nextGuardrails = input.guardrails ?? summary.guardrails;

    // só força 1 deep (bumpa config_changed_at) quando um campo relevante à ANÁLISE
    // mudou (goals/textos/identidade/janela) — evita deep em save idêntico (idempotência).
    // Cadência NÃO entra: muda só a agenda, não a análise.
    const runRelevantChanged =
      JSON.stringify(nextGoals) !== JSON.stringify(cleanGoals(summary.goals)) ||
      nextBusinessContext !== (summary.businessContext ?? null) ||
      nextGuidance !== (summary.guidance ?? null) ||
      nextPersona !== (summary.persona ?? null) ||
      nextTone !== (summary.tone ?? null) ||
      nextSystemPrompt !== (summary.systemPrompt ?? null) ||
      nextWindow !== summary.analysisWindowDays;

    await deps.db
      .update(agents)
      .set({
        goals: nextGoals,
        businessContext: nextBusinessContext,
        guidance: nextGuidance,
        persona: nextPersona,
        tone: nextTone,
        systemPrompt: nextSystemPrompt,
        cadence: nextCadence,
        modelConfig: nextModelConfig,
        autonomyPolicy: nextAutonomy,
        ...(runRelevantChanged ? { configChangedAt: sql`now()` } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(agents.id, summary.agentId), eq(agents.orgId, orgId)));

    // guardrails: linha própria (guardrail_configs). Upsert manual (sem unique em
    // agent_id): pré-4b agents podem não ter linha → insere; senão atualiza.
    if (input.guardrails !== undefined) {
      const gRow = {
        maxBudgetChangePct: nextGuardrails.maxBudgetChangePct,
        maxEntitiesPerDay: nextGuardrails.maxEntitiesPerDay,
        allowedActions: nextGuardrails.allowedActions,
        dryRun: nextGuardrails.dryRun,
        killSwitch: nextGuardrails.killSwitch,
        llmCostCap: nextGuardrails.llmCostCapUsd != null ? String(nextGuardrails.llmCostCapUsd) : null,
      };
      const [g] = await deps.db
        .select({ id: guardrailConfigs.id })
        .from(guardrailConfigs)
        .where(and(eq(guardrailConfigs.agentId, summary.agentId), eq(guardrailConfigs.orgId, orgId)))
        .limit(1);
      if (g) {
        await deps.db.update(guardrailConfigs).set({ ...gRow, updatedAt: sql`now()` }).where(eq(guardrailConfigs.id, g.id));
      } else {
        await deps.db.insert(guardrailConfigs).values({ orgId, agentId: summary.agentId, ...gRow });
      }
    }

    // cadência mudou → re-sincroniza o schedule (worker é o dono; API só enfileira).
    // Sem idempotencyKey: cada job lê o DB mais recente e o schedule é idempotente
    // por key; um jobId fixo poderia descartar um resync enfileirado enquanto o
    // anterior está ativo, deixando o schedule defasado vs o DB.
    if (cadenceChanged) {
      await deps.scheduler.enqueue({
        queue: SCHEDULE_RESYNC_QUEUE,
        name: SCHEDULE_RESYNC_JOB,
        payload: { orgId, adAccountId: accountId },
      });
    }
    return {
      ...summary,
      goals: nextGoals,
      businessContext: nextBusinessContext,
      guidance: nextGuidance,
      persona: nextPersona,
      tone: nextTone,
      systemPrompt: nextSystemPrompt,
      cadence: nextCadence,
      analysisWindowDays: nextWindow,
      autonomyPolicy: nextAutonomy,
      guardrails: nextGuardrails,
    };
  }

  /**
   * Re-semeia o arquétipo (c2): reseta SÓ o comportamento (persona/tone/systemPrompt/
   * autonomyPolicy) para os defaults do arquétipo e PRESERVA meta+contexto+orientações+
   * cadência (dados do usuário). Bumpa config_changed_at (o prompt muda → força 1 deep).
   * Guardrails ficam nos defaults de coluna (sem UI própria até a 5a → reset = no-op).
   */
  async function reseedArchetype(
    orgId: OrgId,
    accountId: string,
    archetype: string,
  ): Promise<AgentSummary> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const defaults = archetypeDefaults(archetype);
    await deps.db
      .update(agents)
      .set({
        archetype: defaults.key,
        // reset = "usa o arquétipo" (null); não gravamos os textos do arquétipo.
        persona: null,
        tone: null,
        systemPrompt: null,
        autonomyPolicy: defaults.autonomyPolicy,
        configChangedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(agents.id, summary.agentId), eq(agents.orgId, orgId)));
    return {
      ...summary,
      archetype: defaults.key,
      persona: null,
      tone: null,
      systemPrompt: null,
      autonomyPolicy: defaults.autonomyPolicy,
      methodologyPreview: methodologyFor(defaults.key),
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

  // ─── Playbook CRUD (Fatia 4 corte 2) ────────────────────────────────────
  // Regras alimentam a análise HOJE (viram recomendação); auto-aplicam na 5a. Toda
  // mutação bumpa config_changed_at (playbook é relevante à análise → força 1 deep).

  /** Marca a config como mudada (força 1 deep run) — playbook afeta a análise. */
  async function bumpConfigChanged(orgId: OrgId, agentId: string): Promise<void> {
    await deps.db
      .update(agents)
      .set({ configChangedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  }

  async function listPlaybookRules(orgId: OrgId, accountId: string): Promise<PlaybookRuleOutput[]> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const rows = await deps.db
      .select()
      .from(playbookRules)
      .where(and(eq(playbookRules.agentId, summary.agentId), eq(playbookRules.orgId, orgId)))
      .orderBy(desc(playbookRules.priority));
    return rows.map(toRuleOutput);
  }

  async function createPlaybookRule(
    orgId: OrgId,
    accountId: string,
    input: PlaybookRuleInput,
  ): Promise<PlaybookRuleOutput> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const [row] = await deps.db
      .insert(playbookRules)
      .values({
        orgId,
        agentId: summary.agentId,
        scope: input.scope,
        whenJson: toWhenJson(input),
        thenJson: input.then,
        thenActionType: input.then.type,
        enabled: input.enabled ?? true,
        priority: input.priority ?? 0,
      })
      .returning();
    if (!row) throw notFound("Falha ao criar a regra.");
    await bumpConfigChanged(orgId, summary.agentId);
    return toRuleOutput(row);
  }

  async function updatePlaybookRule(
    orgId: OrgId,
    accountId: string,
    ruleId: string,
    input: PlaybookRuleInput,
  ): Promise<PlaybookRuleOutput> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const [row] = await deps.db
      .update(playbookRules)
      .set({
        scope: input.scope,
        whenJson: toWhenJson(input),
        thenJson: input.then,
        thenActionType: input.then.type,
        enabled: input.enabled ?? true,
        priority: input.priority ?? 0,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(playbookRules.id, ruleId),
          eq(playbookRules.agentId, summary.agentId),
          eq(playbookRules.orgId, orgId),
        ),
      )
      .returning();
    if (!row) throw notFound("Regra não encontrada.");
    await bumpConfigChanged(orgId, summary.agentId);
    return toRuleOutput(row);
  }

  async function deletePlaybookRule(orgId: OrgId, accountId: string, ruleId: string): Promise<void> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const deleted = await deps.db
      .delete(playbookRules)
      .where(
        and(
          eq(playbookRules.id, ruleId),
          eq(playbookRules.agentId, summary.agentId),
          eq(playbookRules.orgId, orgId),
        ),
      )
      .returning({ id: playbookRules.id });
    if (deleted.length === 0) throw notFound("Regra não encontrada.");
    await bumpConfigChanged(orgId, summary.agentId);
  }

  // ─── Ações do último run + undo (mini-surface, 5a) ──────────────────────
  /** Ações aplicadas (via agent_tool_calls) + sugeridas (metrics_snapshot) do último run. */
  async function listLastRunActions(orgId: OrgId, accountId: string): Promise<LastRunActionsOutput> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const [run] = await deps.db
      .select({ id: agentRuns.id, metricsSnapshot: agentRuns.metricsSnapshot })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, summary.agentId), eq(agentRuns.orgId, orgId)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (!run) return { runId: null, applied: [], suggested: [] };

    const calls = await deps.db
      .select({ id: agentToolCalls.id, toolKey: agentToolCalls.toolKey, args: agentToolCalls.args, idempotencyKey: agentToolCalls.idempotencyKey })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.runId, run.id));
    const undoneKeys = new Set(calls.map((c) => c.idempotencyKey));
    const applied = calls
      .filter((c) => c.toolKey !== UNDO_TOOL_KEY)
      .map((c) => {
        const args = c.args as { target?: { level: string; id: string }; dryRun?: boolean };
        return {
          toolCallId: c.id,
          type: c.toolKey,
          targetLevel: args.target?.level ?? "",
          targetId: args.target?.id ?? "",
          simulated: args.dryRun === true,
          reverted: undoneKeys.has(`${c.id}:${UNDO_TOOL_KEY}`),
        };
      });

    const snapshot = run.metricsSnapshot as { suggestedActions?: Action[] } | null;
    const suggested = (snapshot?.suggestedActions ?? []).map((a) => ({
      type: a.type,
      targetLevel: a.target.level,
      targetId: a.target.id,
      reason: a.reason,
    }));
    return { runId: run.id, applied, suggested };
  }

  /** Pede o undo de uma ação (valida posse + estado; o WORKER reverte de fato). */
  async function requestUndo(orgId: OrgId, accountId: string, toolCallId: string): Promise<void> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const [tc] = await deps.db
      .select({ id: agentToolCalls.id, toolKey: agentToolCalls.toolKey, args: agentToolCalls.args })
      .from(agentToolCalls)
      .innerJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
      .where(and(eq(agentToolCalls.id, toolCallId), eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, summary.agentId)))
      .limit(1);
    if (!tc) throw notFound("Ação não encontrada.");
    if (tc.toolKey === UNDO_TOOL_KEY) throw badRequest("Essa ação já é um desfazer.");
    if ((tc.args as { dryRun?: boolean }).dryRun === true) throw badRequest("Ação simulada não tem o que reverter.");
    await deps.scheduler.enqueue({
      queue: ACTION_UNDO_QUEUE,
      name: ACTION_UNDO_JOB,
      payload: { orgId, adAccountId: accountId, toolCallId },
    });
  }

  return {
    getOrCreateForAccount,
    updateConfig,
    reseedArchetype,
    availableConversions,
    setPaused,
    listMutedCampaigns,
    muteCampaign,
    unmuteCampaign,
    listPlaybookRules,
    createPlaybookRule,
    updatePlaybookRule,
    deletePlaybookRule,
    listLastRunActions,
    requestUndo,
  };
}

/** toolKey do registro de undo (espelha o executor). */
const UNDO_TOOL_KEY = "undo";

/** Janela por-regra ainda não aplicada pelo engine (fast-follow): usa a do agente. */
const PLAYBOOK_WINDOW_PLACEHOLDER = "7d" as const;

/** DTO da API → `PlaybookCondition` (whenJson). `window` = placeholder (ver acima). */
function toWhenJson(input: PlaybookRuleInput): PlaybookCondition {
  return {
    metric: input.metric,
    op: input.op,
    value: input.value,
    window: PLAYBOOK_WINDOW_PLACEHOLDER,
    ...(input.minSpend !== undefined ? { minSpend: input.minSpend } : {}),
  };
}

/** Linha do banco → DTO de saída (achata `whenJson` p/ a superfície da UI). */
function toRuleOutput(row: {
  id: string;
  scope: string;
  whenJson: PlaybookCondition;
  thenJson: { type: string } & Record<string, unknown>;
  enabled: boolean;
  priority: number;
}): PlaybookRuleOutput {
  return {
    id: row.id,
    // `scope` no banco é entityLevel (inclui "account"), mas regras só gravam
    // campaign|adset|ad (validado no input) — cast seguro.
    scope: row.scope as PlaybookRuleOutput["scope"],
    metric: row.whenJson.metric as PlaybookRuleOutput["metric"],
    op: row.whenJson.op,
    value: row.whenJson.value,
    minSpend: row.whenJson.minSpend ?? null,
    then: row.thenJson as PlaybookRuleOutput["then"],
    enabled: row.enabled,
    priority: row.priority,
  };
}

/** Metodologia composta do arquétipo (read-only p/ o "ver metodologia" da UI). */
function methodologyFor(archetype: string): string {
  return composeMethodologyPrompt(archetypeDefaults(archetype));
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
