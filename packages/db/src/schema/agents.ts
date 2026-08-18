import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ActionType,
  AgentGoals,
  AutonomyPolicy,
  PlaybookCondition,
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
    goals: jsonb("goals").$type<AgentGoals>().notNull().default({}),
    // expressão cron por conta (cadência)
    cadence: text("cadence"),
    autonomyPolicy: jsonb("autonomy_policy").$type<AutonomyPolicy>().notNull(),
    tone: text("tone"),
    // config do modelo (provider/model/params) via OpenRouter
    modelConfig: jsonb("model_config").$type<Record<string, unknown>>().notNull().default({}),
    status: agentStatus("status").notNull().default("draft"),
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
    ...timestamps,
  },
  (t) => [index("guardrail_configs_agent_idx").on(t.agentId)],
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
