import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  DEFAULT_MAX_NEW_CAMPAIGNS_PER_DAY,
  DEFAULT_MAX_NEW_DAILY_BUDGET_MINOR,
  DEFAULT_NOTIFY_POLICY,
  DEFAULT_POSTURE,
  DEFAULT_SCALE_PCT,
} from "@trafego/shared";
import type {
  ActionType,
  AgentGoals,
  AutonomyPolicy,
  CadenceSpec,
  NotifyPolicy,
  PlaybookCondition,
  Posture,
} from "@trafego/shared";
import {
  actionType,
  agentStatus,
  entityLevel,
  memoryLifecycle,
  memoryType,
  pk,
  timestamps,
} from "./_shared.js";
import { adAccounts } from "./integrations.js";
import { orgs } from "./tenancy.js";

/** Agente = config personalizável ligada a 1 AdAccount (1:1 no MVP). */
export const agents = pgTable(
  "agents",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    archetype: text("archetype").notNull().default("conservador"),
    persona: text("persona"),
    systemPrompt: text("system_prompt"),
    // Personalização por texto (Fatia 4) — camada ADITIVA sobre o arquétipo:
    // fatos do negócio (contexto) e orientações de comportamento (guidance).
    businessContext: text("business_context"),
    guidance: text("guidance"),
    goals: jsonb("goals").$type<AgentGoals>().notNull().default({}),
    // Cadência da análise (Fatia 4 corte 2) = FONTE ÚNICA `CadenceSpec` (jsonb); o
    // cron 5-campos é sempre DERIVADO por `cadenceToCron` no scheduler. Null = usa o
    // default global (env). Migrada de `text` (cron cru); a migration adiciona o
    // `USING` (Drizzle não o gera p/ text→jsonb) convertendo cron legado em {kind:raw}.
    cadence: jsonb("cadence").$type<CadenceSpec>(),
    autonomyPolicy: jsonb("autonomy_policy").$type<AutonomyPolicy>().notNull(),
    // Notificação proativa (F4): pulso/alerta/push. Default conservador de coluna
    // cobre linhas existentes; o onboarding semeia por arquétipo.
    notifyPolicy: jsonb("notify_policy").$type<NotifyPolicy>().notNull().default(DEFAULT_NOTIFY_POLICY),
    // Postura de comunicação (voz): diretividade/volume/profundidade + preset de
    // experiência. Default conservador de coluna cobre linhas existentes; o
    // onboarding semeia por arquétipo (backfill por-arquétipo = fast-follow).
    posture: jsonb("posture").$type<Posture>().notNull().default(DEFAULT_POSTURE),
    tone: text("tone"),
    // config do modelo (provider/model/params) via OpenRouter
    modelConfig: jsonb("model_config").$type<Record<string, unknown>>().notNull().default({}),
    status: agentStatus("status").notNull().default("draft"),
    // Marcador de "config relevante à análise mudou" (Fatia 4): bumpado ao salvar
    // conversão/contexto/orientações/meta → força 1 deep run no próximo run (o
    // incremental herdaria texto velho, pois só olha métricas/flags).
    configChangedAt: timestamp("config_changed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("agents_org_idx").on(t.orgId),
    index("agents_ad_account_idx").on(t.adAccountId),
  ],
);

/** Rede de segurança configurável (blast radius, cap, kill-switch, dry-run). */
export const guardrailConfigs = pgTable(
  "guardrail_configs",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    maxBudgetChangePct: integer("max_budget_change_pct").notNull().default(20),
    maxEntitiesPerDay: integer("max_entities_per_day").notNull().default(3),
    allowedActions: jsonb("allowed_actions")
      .$type<ActionType[]>()
      .notNull()
      .default(["pause_entity"]),
    dryRun: boolean("dry_run").notNull().default(true),
    killSwitch: boolean("kill_switch").notNull().default(false),
    // cap de custo LLM por org/período (protege margem)
    llmCostCap: numeric("llm_cost_cap", { precision: 12, scale: 4 }),
    // ─── Limites de GASTO NOVO (Fatia 7 — criação) ───
    maxNewDailyBudgetMinor: integer("max_new_daily_budget_minor")
      .notNull()
      .default(DEFAULT_MAX_NEW_DAILY_BUDGET_MINOR),
    maxNewCampaignsPerDay: integer("max_new_campaigns_per_day")
      .notNull()
      .default(DEFAULT_MAX_NEW_CAMPAIGNS_PER_DAY),
    scalePct: integer("scale_pct").notNull().default(DEFAULT_SCALE_PCT),
    ...timestamps,
  },
  // 1 linha de guardrail por agente (rede única): sem isso duplicatas fariam a leitura
  // `.limit(1)` escolher linha stale (poderia ignorar kill-switch/dry-run — §12).
  (t) => [uniqueIndex("guardrail_configs_agent_uq").on(t.agentId)],
);

/** Regra determinística `condição → ação` (config do usuário). */
export const playbookRules = pgTable(
  "playbook_rules",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // nível-alvo (campaign|adset|ad) — nunca "account"
    scope: entityLevel("scope").notNull(),
    whenJson: jsonb("when_json").$type<PlaybookCondition>().notNull(),
    thenJson: jsonb("then_json")
      .$type<{ type: ActionType } & Record<string, unknown>>()
      .notNull(),
    thenActionType: actionType("then_action_type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("playbook_rules_agent_idx").on(t.agentId)],
);

/**
 * Entidades silenciadas pelo usuário (opt-out) — excluídas da análise do agente.
 * Genérico (level + externalId): hoje só campanha; extensível a adset/ad sem migração
 * de forma (§13). Soft por natureza (linha some ao reativar). Org-scoped via agente.
 */
export const agentMutedEntities = pgTable(
  "agent_muted_entities",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // nível da entidade silenciada (campaign|adset|ad) — nunca "account".
    entityLevel: entityLevel("entity_level").notNull(),
    // id externo da entidade na plataforma (ex: id da campanha Meta).
    externalId: text("external_id").notNull(),
    ...timestamps,
  },
  (t) => [
    index("agent_muted_entities_agent_idx").on(t.agentId),
    uniqueIndex("agent_muted_entities_uq").on(t.agentId, t.entityLevel, t.externalId),
  ],
);

/** Memória do agente (objetivos, ações passadas, rejeições, fatos). */
export const agentMemory = pgTable(
  "agent_memory",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    type: memoryType("type").notNull(),
    content: text("content").notNull(),
    confidence: real("confidence"),
    lifecycle: memoryLifecycle("lifecycle").notNull().default("active"),
    ...timestamps,
  },
  (t) => [index("agent_memory_agent_idx").on(t.agentId)],
);
