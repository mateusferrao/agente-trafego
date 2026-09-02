// Casca de IO (Bloco 2, S2.2) da escrita de config do agente: carrega o estado do
// banco, chama o RESOLVER puro (@trafego/core), persiste e (opcional) audita. Fonte
// ÚNICA reusada pela API (hoje) e pelo chat do worker (depois). §4: IO na borda.

import { and, eq, sql } from "drizzle-orm";
import { agents, agentToolBindings, auditLog, guardrailConfigs, type Database } from "@trafego/db";
import {
  archetypeDefaults,
  autonomyPolicyWeakens,
  resolveAgentConfigChange,
  resolveEnabledTools,
  unseedIdentity,
  windowFromModelConfig,
  CONFIG_CHANGE_LABELS,
  type AgentConfigPatch,
  type AgentConfigState,
} from "@trafego/core";
import {
  DEFAULT_NOTIFY_POLICY,
  DEFAULT_POSTURE,
  GATEABLE_TOOL_KEYS,
  SCHEDULE_RESYNC_JOB,
  SCHEDULE_RESYNC_QUEUE,
  toGuardrailConfig,
} from "@trafego/shared";
import type { AutonomyPolicy, CadenceSpec, NotifyPolicy, OrgId, Posture, ToolBindingMode } from "@trafego/shared";
import type { SchedulerPort } from "@trafego/shared/ports";

/** Dependências de infra da camada (composition root injeta). */
export interface AgentConfigIoDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
}

/**
 * Ator do write, quando se quer trilha de auditoria. A API NÃO passa (config não era
 * auditada); o chat do worker passará (quem falou no WhatsApp mudou a config).
 */
export interface AgentConfigAudit {
  readonly actor: {
    /** rótulo do ator (ex: "user:contato", "agent"). */
    readonly label: string;
    /** id do user, quando houver (FK opcional). */
    readonly userId?: string;
  };
  /** contexto extra da trilha (ex: `{ channel: "whatsapp" }` p/ escrita por chat). */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Persiste o patch de on/off das tools em `agent_tool_bindings` (A3): cada chave presente
 * vira uma linha explícita (enabled|disabled) por (agente, tool) — upsert idempotente. Chaves
 * ausentes seguem no fallback (allowedActions/default). Fonte ÚNICA — a API (site) e o chat
 * (auto-config) escrevem pela MESMA função (antes só a API tinha isso, cópia local).
 */
export async function applyToolBindingsChange(
  db: Database,
  input: { readonly orgId: OrgId; readonly agentId: string; readonly patch: Partial<Record<string, boolean>> },
): Promise<void> {
  const entries = Object.entries(input.patch).filter((e): e is [string, boolean] => typeof e[1] === "boolean");
  for (const [toolKey, enabled] of entries) {
    const mode: ToolBindingMode = enabled ? "enabled" : "disabled";
    await db
      .insert(agentToolBindings)
      .values({ orgId: input.orgId, agentId: input.agentId, toolKey, mode })
      .onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode } });
  }
}

/** Resolve o on/off por-ação ATUAL (A3) — as 6 capacidades gateáveis, já resolvidas (fallback
 *  allowedActions/default aplicado). Usado por `loadAgentConfigState` (chat) e reusável pela API. */
export async function loadToolBindingsState(
  db: Database,
  orgId: OrgId,
  agentId: string,
  allowedActionsFallback: readonly string[],
): Promise<Readonly<Record<string, boolean>>> {
  const rows = await db
    .select({ toolKey: agentToolBindings.toolKey, mode: agentToolBindings.mode })
    .from(agentToolBindings)
    .where(and(eq(agentToolBindings.agentId, agentId), eq(agentToolBindings.orgId, orgId)));
  const map = new Map<string, ToolBindingMode>(rows.map((r) => [r.toolKey, r.mode as ToolBindingMode]));
  const enabled = resolveEnabledTools(map, new Set(allowedActionsFallback));
  return Object.fromEntries(GATEABLE_TOOL_KEYS.map((k) => [k, enabled.has(k)]));
}

/** Ação de auditoria da escrita de config (durável — não vaza fase). */
const AGENT_CONFIG_UPDATE_ACTION = "agent.config.update";
/** Ação de auditoria do re-seed de arquétipo. */
const AGENT_ARCHETYPE_RESEED_ACTION = "agent.archetype.reseed";

/** Resultado do apply — sucesso carrega o `next` (a API projeta o AgentSummary). */
export type AgentConfigChangeResult =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly changed: readonly string[];
      readonly weakensSafety: boolean;
      readonly next: AgentConfigState;
    };

export interface ApplyAgentConfigInput {
  readonly orgId: OrgId;
  readonly agentId: string;
  readonly accountId: string;
  readonly patch: AgentConfigPatch;
  readonly audit?: AgentConfigAudit;
}

/**
 * Aplica um patch de config: relê o estado FRESCO, resolve (puro), persiste como o
 * `updateConfig` original (agents + guardrail_configs + resync) e audita se pedido.
 */
export async function applyAgentConfigChange(
  deps: AgentConfigIoDeps,
  input: ApplyAgentConfigInput,
): Promise<AgentConfigChangeResult> {
  const { db, scheduler } = deps;
  const { orgId, agentId, accountId, patch, audit } = input;

  const state = await loadAgentConfigState(db, orgId, agentId);
  if (!state) return { ok: false, error: "Agente não encontrado." };

  const resolution = resolveAgentConfigChange(state, patch);
  if (resolution.error) return { ok: false, error: resolution.error };
  const { next, changed, runRelevantChanged, cadenceChanged, notifyPolicyChanged, weakensSafety } = resolution;

  // agents: goals/textos/identidade/cadence/modelConfig/autonomia. configChangedAt só
  // quando um campo relevante à análise mudou (força 1 deep no próximo run).
  await db
    .update(agents)
    .set({
      goals: next.goals,
      businessContext: next.businessContext,
      guidance: next.guidance,
      persona: next.persona,
      tone: next.tone,
      systemPrompt: next.systemPrompt,
      cadence: next.cadence,
      modelConfig: next.modelConfig,
      autonomyPolicy: next.autonomyPolicy,
      notifyPolicy: next.notifyPolicy,
      posture: next.posture,
      ...(runRelevantChanged ? { configChangedAt: sql`now()` } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));

  // guardrails: linha própria — só toca quando o patch os enviou (upsert atômico pelo
  // unique(agent_id), cobre agentes sem linha sem TOCTOU).
  if (patch.guardrails !== undefined) {
    const g = next.guardrails;
    const gValues = {
      maxBudgetChangePct: g.maxBudgetChangePct,
      maxEntitiesPerDay: g.maxEntitiesPerDay,
      allowedActions: [...g.allowedActions],
      dryRun: g.dryRun,
      killSwitch: g.killSwitch,
      llmCostCap: g.llmCostCapUsd != null ? String(g.llmCostCapUsd) : null,
      // limites de gasto novo (Fatia 7) — só sobrescreve quando vierem (mantém default de coluna).
      ...(g.maxNewDailyBudgetMinor != null ? { maxNewDailyBudgetMinor: g.maxNewDailyBudgetMinor } : {}),
      ...(g.maxNewCampaignsPerDay != null ? { maxNewCampaignsPerDay: g.maxNewCampaignsPerDay } : {}),
      ...(g.scalePct != null ? { scalePct: g.scalePct } : {}),
    };
    await db
      .insert(guardrailConfigs)
      .values({ orgId, agentId, ...gValues })
      .onConflictDoUpdate({ target: guardrailConfigs.agentId, set: { ...gValues, updatedAt: sql`now()` } });
  }

  // on/off por-ação (A3) — tabela à parte, não é coluna de `agents`/`guardrail_configs`.
  // Só as chaves ENVIADAS no patch (leaf-merge já resolvido no `next.toolBindings` pelo core,
  // mas a PERSISTÊNCIA usa o patch cru — não reescreve as 6 chaves toda vez).
  if (patch.toolBindings) await applyToolBindingsChange(db, { orgId, agentId, patch: patch.toolBindings });

  // cadência da análise OU da proatividade (F4d: o pulso tem scheduler próprio) mudou
  // → re-sincroniza (worker é o dono; aqui só enfileira). resyncAccountSchedule relê
  // AMBOS os schedulers do zero, então 1 enqueue cobre os dois casos.
  if (cadenceChanged || notifyPolicyChanged) {
    await scheduler.enqueue({
      queue: SCHEDULE_RESYNC_QUEUE,
      name: SCHEDULE_RESYNC_JOB,
      payload: { orgId, adAccountId: accountId },
    });
  }

  if (audit) await writeAudit(db, orgId, agentId, AGENT_CONFIG_UPDATE_ACTION, state, next, audit);

  return { ok: true, changed, weakensSafety, next };
}

/** Resultado do re-seed — a API projeta o AgentSummary a partir daqui. */
export type AgentReseedResult =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly archetype: string;
      readonly cadence: CadenceSpec | null;
      readonly autonomyPolicy: AutonomyPolicy;
      /** proatividade (F4d) — resetada pro default do arquétipo (mesma semântica da autonomia). */
      readonly notifyPolicy: NotifyPolicy;
      /** postura (voz) — resetada pro default do arquétipo. */
      readonly posture: Posture;
      readonly changed: readonly string[];
      readonly weakensSafety: boolean;
    };

export interface ReseedArchetypeInput {
  readonly orgId: OrgId;
  readonly agentId: string;
  readonly accountId: string;
  readonly archetype: string;
  readonly audit?: AgentConfigAudit;
}

/**
 * Re-semeia o arquétipo: reseta SÓ o comportamento (persona/tone/systemPrompt/autonomia)
 * para os defaults do arquétipo e PRESERVA meta+contexto+orientações. A cadência do
 * usuário é preservada; a default do arquétipo só entra quando ainda no padrão (null).
 * Sempre bumpa configChangedAt (o prompt muda → força 1 deep).
 */
export async function reseedArchetypeChange(
  deps: AgentConfigIoDeps,
  input: ReseedArchetypeInput,
): Promise<AgentReseedResult> {
  const { db, scheduler } = deps;
  const { orgId, agentId, accountId, archetype, audit } = input;

  const state = await loadAgentConfigState(db, orgId, agentId);
  if (!state) return { ok: false, error: "Agente não encontrado." };

  const defaults = archetypeDefaults(archetype);
  const nextCadence = state.cadence ?? defaults.defaultCadence ?? null;
  const cadenceChanged = JSON.stringify(nextCadence) !== JSON.stringify(state.cadence);
  // proatividade (F4d): comportamento do agente, mesma semântica da autonomia (reset
  // incondicional pro default do arquétipo — não tem "não configurado" pra preservar,
  // ao contrário da cadência da análise).
  const notifyPolicyChanged = JSON.stringify(defaults.defaultNotifyPolicy) !== JSON.stringify(state.notifyPolicy);
  // postura: irmã de persona/tom — reset incondicional pro default do arquétipo.
  const postureChanged = JSON.stringify(defaults.defaultPosture) !== JSON.stringify(state.posture);

  await db
    .update(agents)
    .set({
      archetype: defaults.key,
      // reset = "usa o arquétipo" (null); não gravamos os textos do arquétipo.
      persona: null,
      tone: null,
      systemPrompt: null,
      autonomyPolicy: defaults.autonomyPolicy,
      cadence: nextCadence,
      notifyPolicy: defaults.defaultNotifyPolicy,
      posture: defaults.defaultPosture,
      configChangedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));

  if (cadenceChanged || notifyPolicyChanged) {
    await scheduler.enqueue({
      queue: SCHEDULE_RESYNC_QUEUE,
      name: SCHEDULE_RESYNC_JOB,
      payload: { orgId, adAccountId: accountId },
    });
  }

  // o que mudou (p/ o eco do chat): identidade que estava setada (some ao resetar),
  // autonomia, proatividade e cadência semeada.
  const changed: string[] = [];
  if (state.persona !== null) changed.push(CONFIG_CHANGE_LABELS.persona);
  if (state.tone !== null) changed.push(CONFIG_CHANGE_LABELS.tone);
  if (state.systemPrompt !== null) changed.push(CONFIG_CHANGE_LABELS.systemPrompt);
  if (JSON.stringify(state.autonomyPolicy) !== JSON.stringify(defaults.autonomyPolicy))
    changed.push(CONFIG_CHANGE_LABELS.autonomyPolicy);
  if (cadenceChanged) changed.push(CONFIG_CHANGE_LABELS.cadence);
  if (notifyPolicyChanged) changed.push(CONFIG_CHANGE_LABELS.notifyPolicy);
  if (postureChanged) changed.push(CONFIG_CHANGE_LABELS.posture);

  const weakensSafety = autonomyPolicyWeakens(state.autonomyPolicy, defaults.autonomyPolicy);

  if (audit) {
    const after: AgentConfigState = {
      ...state,
      persona: null,
      tone: null,
      systemPrompt: null,
      autonomyPolicy: defaults.autonomyPolicy,
      cadence: nextCadence,
      notifyPolicy: defaults.defaultNotifyPolicy,
      posture: defaults.defaultPosture,
    };
    await writeAudit(db, orgId, agentId, AGENT_ARCHETYPE_RESEED_ACTION, state, after, audit);
  }

  return {
    ok: true,
    archetype: defaults.key,
    cadence: nextCadence,
    autonomyPolicy: defaults.autonomyPolicy,
    notifyPolicy: defaults.defaultNotifyPolicy,
    posture: defaults.defaultPosture,
    changed,
    weakensSafety,
  };
}

/**
 * Monta o `AgentConfigState` neutro a partir da linha `agents` + `guardrail_configs`.
 * Identidade é UNSEEDED (valor == default do arquétipo → null, "vazio = usa arquétipo").
 * EXPORTADO (S2.3): o gate do chat carrega o estado atual p/ computar o eco sem persistir.
 */
export async function loadAgentConfigState(
  db: Database,
  orgId: OrgId,
  agentId: string,
): Promise<AgentConfigState | null> {
  const [row] = await db
    .select({
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
      posture: agents.posture,
      archetype: agents.archetype,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1);
  if (!row) return null;

  const [gRow] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
    .limit(1);
  const guardrails = toGuardrailConfig(gRow);
  // on/off por-ação (A3) — mesma fonte/lógica que o apply/chat/site já leem (resolveEnabledTools),
  // pra o resolver poder ecoar/diffar sem drift de outra fonte.
  const toolBindings = await loadToolBindingsState(db, orgId, agentId, guardrails.allowedActions);

  return {
    goals: row.goals ?? {},
    businessContext: row.businessContext ?? null,
    guidance: row.guidance ?? null,
    persona: unseedIdentity("persona", row.persona, row.archetype),
    tone: unseedIdentity("tone", row.tone, row.archetype),
    systemPrompt: unseedIdentity("systemPrompt", row.systemPrompt, row.archetype),
    cadence: row.cadence ?? null,
    analysisWindowDays: windowFromModelConfig(row.modelConfig),
    autonomyPolicy: row.autonomyPolicy,
    guardrails,
    modelConfig: row.modelConfig ?? {},
    // fallback defensivo (linha pré-migração/fake de teste); a coluna real tem
    // default NOT NULL (backfill automático), então isto é só uma rede de segurança.
    notifyPolicy: row.notifyPolicy ?? DEFAULT_NOTIFY_POLICY,
    posture: row.posture ?? DEFAULT_POSTURE,
    toolBindings,
  };
}

/** Grava 1 linha de auditoria com os estados antes/depois (JSON serializável). */
async function writeAudit(
  db: Database,
  orgId: OrgId,
  agentId: string,
  action: string,
  before: AgentConfigState,
  after: AgentConfigState,
  audit: AgentConfigAudit,
): Promise<void> {
  await db.insert(auditLog).values({
    orgId,
    actor: audit.actor.label,
    ...(audit.actor.userId ? { actorUserId: audit.actor.userId } : {}),
    action,
    target: `agent:${agentId}`,
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
    ...(audit.metadata ? { metadata: audit.metadata } : {}),
  });
}

// Ações de mutação de aprendizado (v3) — reusadas por site + chat.
export * from "./learning-actions.js";
