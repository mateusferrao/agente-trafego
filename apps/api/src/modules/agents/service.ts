import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  adAccounts,
  agents,
  agentMutedEntities,
  agentRuns,
  agentToolCalls,
  conversionLabels,
  entityAnalyses,
  guardrailConfigs,
  insightsSnapshots,
  loadOrgTimezone,
  playbookRules,
  type Database,
} from "@trafego/db";
import {
  archetypeCatalog,
  archetypeDefaults,
  composeMethodologyPrompt,
  daysAgoInTz,
  todayInTz,
  unseedIdentity,
  windowFromModelConfig,
  ADVANCED_SCALAR_KEYS,
  DEFAULT_ARCHETYPE_KEY,
  type AgentConfigPatch,
  type NotifyPolicyPatch,
} from "@trafego/core";
import { applyAgentConfigChange, reseedArchetypeChange } from "@trafego/agent-config";
import {
  ACTION_UNDO_QUEUE,
  ACTION_UNDO_JOB,
  GUARDRAIL_DEFAULTS,
  toGuardrailConfig,
  DEFAULT_TIMEZONE,
  UNDO_BLOCKED_TOOL_KEY,
  UNDO_TOOL_KEY,
} from "@trafego/shared";
import type { Action, AgentId, AutonomyPolicy, OrgId, StoredInsightMetrics } from "@trafego/shared/types";
import type { ApprovalPort, SchedulerPort } from "@trafego/shared/ports";
import { ANALYSIS_WINDOW_DEFAULT_DAYS } from "@trafego/shared";
import { badRequest, notFound } from "../../middleware/error-handler.js";
import {
  type AgentConfigInput,
  type AgentSummary,
  type AvailableConversionsOutput,
  type LastRunActionsOutput,
  type ModelConfigInput,
  type NotifyPolicyInput,
  type PlaybookRuleInput,
  type PlaybookRuleOutput,
  type QualityDefaultsOutput,
} from "./schema.js";
import type { PlaybookCondition } from "@trafego/shared/types";
import { computeAppliedActions, DAY_MS, entityIdsMissingNames } from "../../lib/applied-actions.js";

/** Janela recente p/ listar as conversões que a conta reportou (dias). */
const AVAILABLE_CONVERSIONS_WINDOW_DAYS = 30;

export interface AgentsDeps {
  readonly db: Database;
  /** enfileira o resync do schedule (worker = dono do scheduler) ao salvar a cadência. */
  readonly scheduler: SchedulerPort;
  /** pendentes de OK (mini-surface) — fonte da verdade das sugeridas (5b). */
  readonly approvals: ApprovalPort;
  /** janela (dias) em que "reverter" segue disponível (5b) — env. */
  readonly revertTtlDays: number;
  /** defaults do sistema dos limiares de qualidade (env) — placeholder real na UI (6c). */
  readonly qualityDefaults: QualityDefaultsOutput;
}

/**
 * Slice de agentes (3a mínimo): garante o agente default por conta (zero-config,
 * criação lazy pelo arquétipo `conservador`) e edita a META (target CPA/ROAS).
 * A superfície completa de config = Fatia 4.
 */
export function createAgentsService(deps: AgentsDeps) {
  /** Lê a linha `guardrail_configs` → shape do contrato (ausente → defaults). Fonte única. */
  async function loadGuardrails(orgId: OrgId, agentId: string): Promise<AgentSummary["guardrails"]> {
    const [g] = await deps.db
      .select()
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
      .limit(1);
    // GuardrailConfig (core) usa allowedActions readonly; o contrato zod é mutável — mesmo shape.
    return toGuardrailConfig(g) as AgentSummary["guardrails"];
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
        notifyPolicy: agents.notifyPolicy,
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
        modelConfig: projectModelConfig(existing.modelConfig),
        qualityDefaults: deps.qualityDefaults,
        notifyPolicy: existing.notifyPolicy,
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
        notifyPolicy: defaults.defaultNotifyPolicy,
        posture: defaults.defaultPosture,
        // ativo ao ser criado → o cron passa a cuidar da conta (pausável pelo dono).
        status: "active",
      })
      .returning({ id: agents.id });
    if (!row) throw notFound("Falha ao criar o agente.");
    // Semeia a linha de guardrails (rede independente) com os defaults de coluna —
    // o worker lê no run (só morde na escrita, 5a). Sem isso o read cairia no fallback.
    await deps.db
      .insert(guardrailConfigs)
      .values({ orgId, agentId: row.id })
      .onConflictDoNothing({ target: guardrailConfigs.agentId });
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
      guardrails: GUARDRAIL_DEFAULTS as AgentSummary["guardrails"],
      modelConfig: {},
      qualityDefaults: deps.qualityDefaults,
      notifyPolicy: defaults.defaultNotifyPolicy,
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
    // getOrCreate resolve o agentId + a projeção base do AgentSummary (methodology/
    // paused/archetype). A SEMÂNTICA (merge/validação/diff/persistência) vive na
    // camada compartilhada — fonte única com o chat do worker, sem drift.
    const summary = await getOrCreateForAccount(orgId, accountId);
    const result = await applyAgentConfigChange(
      { db: deps.db, scheduler: deps.scheduler },
      { orgId, agentId: summary.agentId, accountId, patch: toConfigPatch(input) },
    );
    // erro tipado do core → exceção só aqui, na casca (mesma mensagem de antes).
    if (!result.ok) throw badRequest(result.error);

    // projeta o AgentSummary a partir do estado resolvido — idêntico ao de antes.
    const { next } = result;
    return {
      ...summary,
      goals: next.goals,
      businessContext: next.businessContext,
      guidance: next.guidance,
      persona: next.persona,
      tone: next.tone,
      systemPrompt: next.systemPrompt,
      cadence: next.cadence,
      analysisWindowDays: next.analysisWindowDays,
      autonomyPolicy: next.autonomyPolicy,
      guardrails: next.guardrails as AgentSummary["guardrails"],
      modelConfig: projectModelConfig(next.modelConfig),
      qualityDefaults: deps.qualityDefaults,
      notifyPolicy: next.notifyPolicy,
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
    // reset do comportamento (persona/tone/prompt/autonomia + cadência semeada) na
    // camada compartilhada — fonte única com o chat do worker.
    const result = await reseedArchetypeChange(
      { db: deps.db, scheduler: deps.scheduler },
      { orgId, agentId: summary.agentId, accountId, archetype },
    );
    if (!result.ok) throw badRequest(result.error);
    return {
      ...summary,
      archetype: result.archetype,
      persona: null,
      tone: null,
      systemPrompt: null,
      autonomyPolicy: result.autonomyPolicy,
      cadence: result.cadence,
      notifyPolicy: result.notifyPolicy,
      methodologyPreview: methodologyFor(result.archetype),
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
    // Janela de datas no fuso da org (não UTC): `insights_snapshots.date` é gravada no fuso
    // da conta — calcular "hoje" em UTC deslocaria a janela à noite (mesma raiz do fix de fuso).
    const tz = await loadOrgTimezone(deps.db, orgId, DEFAULT_TIMEZONE);
    const now = new Date();
    const until = todayInTz(now, tz);
    const since = daysAgoInTz(now, tz, AVAILABLE_CONVERSIONS_WINDOW_DAYS);
    const rows = await deps.db
      .select({ metricsJson: insightsSnapshots.metricsJson })
      .from(insightsSnapshots)
      .where(
        and(
          eq(insightsSnapshots.orgId, orgId),
          eq(insightsSnapshots.adAccountId, accountId),
          eq(insightsSnapshots.entityLevel, "account"),
          gte(insightsSnapshots.date, since),
          lte(insightsSnapshots.date, until),
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

  // ─── Ações recentes + undo (mini-surface, 5a/5b) ────────────────────────
  /**
   * Ações APLICADAS recentes (via agent_tool_calls, janela do TTL de revert —
   * cross-run: uma aprovação pode ter sido decidida por um run mais antigo que o
   * mais recente) + SUGERIDAS (approvals pendentes, cross-run) + BARRADAS (do
   * último run, snapshot congelado).
   */
  async function listLastRunActions(orgId: OrgId, accountId: string): Promise<LastRunActionsOutput> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const [run] = await deps.db
      .select({ id: agentRuns.id, metricsSnapshot: agentRuns.metricsSnapshot })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, summary.agentId), eq(agentRuns.orgId, orgId)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (!run) return { runId: null, applied: [], suggested: [], dropped: [] };

    // Aplicadas: cross-run, janela do TTL de revert (mesmo prazo em que "Reverter"
    // fica disponível) — não só o run mais recente, senão uma aprovação decidida
    // agora mas PROPOSTA por um run mais antigo nunca apareceria aqui.
    const since = new Date(Date.now() - deps.revertTtlDays * DAY_MS);
    const calls = await deps.db
      .select({
        id: agentToolCalls.id,
        runId: agentToolCalls.runId,
        toolKey: agentToolCalls.toolKey,
        args: agentToolCalls.args,
        result: agentToolCalls.result,
        idempotencyKey: agentToolCalls.idempotencyKey,
        createdAt: agentToolCalls.createdAt,
      })
      .from(agentToolCalls)
      .innerJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
      .where(and(eq(agentRuns.agentId, summary.agentId), eq(agentRuns.orgId, orgId), gte(agentToolCalls.createdAt, since)));

    const snapshot = run.metricsSnapshot as {
      droppedActions?: { action: Action; reason: string }[];
    } | null;
    const droppedActions = snapshot?.droppedActions ?? [];
    // Sugeridas = pendentes de OK (fonte da verdade: `approvals`), TODAS do agente
    // (cross-run), não só as do último run. `barradas` (dropped) seguem do snapshot.
    const pendingApprovals = await deps.approvals.listPendingByAgent(summary.agentId as AgentId);
    // fallback p/ tool_calls antigos (gravados antes do target carregar `name`) — os
    // novos já vêm com o nome embutido (decide_actions enriquece via `state.entities`,
    // cobre inclusive entidade pausada que nunca passa pelo mapa/LLM).
    const entityIds = entityIdsMissingNames(calls);
    for (const a of pendingApprovals) if (!a.action.target.name) entityIds.add(a.action.target.id);
    for (const d of droppedActions) if (!d.action.target.name) entityIds.add(d.action.target.id);
    const nameByEntityId = await loadEntityNames(summary.agentId, entityIds);

    const applied = computeAppliedActions(calls, deps.revertTtlDays, nameByEntityId).map((a) => ({
      ...a,
      // "O que o agente fez" é cross-run (ver acima); marca quando a ação foi
      // aplicada por uma análise DIFERENTE da que esta página está mostrando.
      fromPreviousRun: a.runId !== run.id,
    }));

    const suggested = pendingApprovals.map((a) => ({
      approvalId: a.id,
      type: a.action.type,
      targetLevel: a.action.target.level,
      targetId: a.action.target.id,
      targetName: a.action.target.name ?? nameByEntityId.get(a.action.target.id) ?? null,
      reason: a.action.reason,
      expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
      // "Sugeridas" é cross-run (a caixa de decisões em aberto do agente); marca quando
      // a pendente veio de uma análise DIFERENTE da que esta página está mostrando —
      // evita a leitura de que ela é fruto do run atual.
      fromPreviousRun: a.runId !== run.id,
    }));

    const dropped = droppedActions.map((d) => ({
      type: d.action.type,
      targetLevel: d.action.target.level,
      targetId: d.action.target.id,
      targetName: d.action.target.name ?? nameByEntityId.get(d.action.target.id) ?? null,
      reason: d.reason,
    }));
    return { runId: run.id, applied, suggested, dropped };
  }

  /** Rótulo legível por entidade (última análise conhecida) — vazio não bate na tabela. */
  async function loadEntityNames(agentId: string, entityIds: ReadonlySet<string>): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (entityIds.size === 0) return map;
    const rows = await deps.db
      .select({ entityId: entityAnalyses.entityId, entityName: entityAnalyses.entityName })
      .from(entityAnalyses)
      .where(and(eq(entityAnalyses.agentId, agentId), inArray(entityAnalyses.entityId, [...entityIds])));
    for (const r of rows) if (r.entityName) map.set(r.entityId, r.entityName);
    return map;
  }

  /**
   * Pede o undo de uma ação (valida posse + estado + TTL; o WORKER reverte de fato).
   * `force` = "reverter mesmo assim" (ignora o re-check de drift no worker).
   */
  async function requestUndo(
    orgId: OrgId,
    accountId: string,
    toolCallId: string,
    force = false,
  ): Promise<void> {
    const summary = await getOrCreateForAccount(orgId, accountId);
    const [tc] = await deps.db
      .select({
        id: agentToolCalls.id,
        toolKey: agentToolCalls.toolKey,
        args: agentToolCalls.args,
        createdAt: agentToolCalls.createdAt,
      })
      .from(agentToolCalls)
      .innerJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
      .where(and(eq(agentToolCalls.id, toolCallId), eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, summary.agentId)))
      .limit(1);
    if (!tc) throw notFound("Ação não encontrada.");
    if (tc.toolKey === UNDO_TOOL_KEY || tc.toolKey === UNDO_BLOCKED_TOOL_KEY)
      throw badRequest("Essa ação já é um desfazer.");
    if ((tc.args as { dryRun?: boolean }).dryRun === true) throw badRequest("Ação simulada não tem o que reverter.");
    if (Date.now() - tc.createdAt.getTime() > deps.revertTtlDays * DAY_MS)
      throw badRequest("O prazo para reverter esta ação expirou.");
    await deps.scheduler.enqueue({
      queue: ACTION_UNDO_QUEUE,
      name: ACTION_UNDO_JOB,
      payload: { orgId, adAccountId: accountId, toolCallId, force },
    });
  }

  /** Catálogo de arquétipos (estático) p/ a UI de seleção (6c). */
  function listArchetypes(): { archetypes: ReturnType<typeof archetypeCatalog> } {
    return { archetypes: archetypeCatalog() };
  }

  return {
    getOrCreateForAccount,
    updateConfig,
    reseedArchetype,
    listArchetypes,
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

/**
 * Traduz o DTO da API (`AgentConfigInput`) → `AgentConfigPatch` do core. Preserva a
 * semântica de patch (só inclui as chaves ENVIADAS; `undefined` = preserva). A
 * validação/merge/diff vivem no resolver (`resolveAgentConfigChange`).
 */
function toConfigPatch(input: AgentConfigInput): AgentConfigPatch {
  return {
    ...(input.goals !== undefined ? { goals: input.goals } : {}),
    ...(input.businessContext !== undefined ? { businessContext: input.businessContext } : {}),
    ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
    ...(input.persona !== undefined ? { persona: input.persona } : {}),
    ...(input.tone !== undefined ? { tone: input.tone } : {}),
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.cadence !== undefined ? { cadence: input.cadence } : {}),
    ...(input.analysisWindowDays !== undefined ? { analysisWindowDays: input.analysisWindowDays } : {}),
    ...(input.autonomyPolicy !== undefined ? { autonomyPolicy: cleanAutonomy(input.autonomyPolicy) } : {}),
    ...(input.guardrails !== undefined ? { guardrails: input.guardrails } : {}),
    ...(input.modelConfig !== undefined ? { modelConfig: input.modelConfig } : {}),
    ...(input.notifyPolicy !== undefined ? { notifyPolicy: toNotifyPolicyPatch(input.notifyPolicy) } : {}),
  };
}

/** Traduz o DTO aninhado (por sub-objeto) → o patch FLAT do core (leaf-merge). */
function toNotifyPolicyPatch(n: NotifyPolicyInput): NotifyPolicyPatch {
  return {
    ...(n.pulse !== undefined ? { pulseEnabled: n.pulse.enabled, pulseCadence: n.pulse.cadence } : {}),
    ...(n.alerts !== undefined
      ? { alertsEnabled: n.alerts.enabled, alertsSensitivity: n.alerts.sensitivity, alertsThrottleHours: n.alerts.throttleHours }
      : {}),
    ...(n.runPush !== undefined ? { runPushEnabled: n.runPush.enabled } : {}),
  };
}

/**
 * Normaliza a autonomia do DTO (zod) → `AutonomyPolicy` estrito: só inclui o kill-switch
 * `autoConfigViaChat` quando definido (omite `undefined` — exactOptionalPropertyTypes).
 */
function cleanAutonomy(p: NonNullable<AgentConfigInput["autonomyPolicy"]>): AutonomyPolicy {
  return {
    bySource: p.bySource,
    ...(p.autoConfigViaChat !== undefined ? { autoConfigViaChat: p.autoConfigViaChat } : {}),
  };
}

/** Projeta só os knobs conhecidos do model_config (o AgentSummary não vaza windowDays etc.). */
function projectModelConfig(mc: Readonly<Record<string, unknown>> | null | undefined): ModelConfigInput {
  const src = (mc && typeof mc === "object" ? mc : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ADVANCED_SCALAR_KEYS) if (src[k] !== undefined) out[k] = src[k];
  if (src.quality && typeof src.quality === "object") out.quality = src.quality;
  return out as ModelConfigInput;
}
