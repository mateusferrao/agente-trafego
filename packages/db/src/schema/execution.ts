import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Action } from "@trafego/shared";
import {
  approvalStatus,
  feedbackVote,
  outcomeStatus,
  pk,
  recommendationStatus,
  riskLevel,
  runStatus,
  runTrigger,
  timestamps,
} from "./_shared.js";
import { agents } from "./agents.js";
import { orgs } from "./tenancy.js";
import { contacts } from "./integrations.js";

/** Execução do agente (análise). Congela config + custo p/ reprodutibilidade. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    trigger: runTrigger("trigger").notNull(),
    status: runStatus("status").notNull().default("pending"),
    // congela a config no momento do run
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    tokenUsage: jsonb("token_usage").$type<Record<string, unknown>>(),
    costSnapshot: numeric("cost_snapshot", { precision: 12, scale: 4 }),
    // resumo em linguagem natural da análise (LLM) — exibido no site/WhatsApp.
    summary: text("summary"),
    // análise parcial (degradação graciosa do governor — §7) → nota na UI.
    partial: boolean("partial").notNull().default(false),
    // KPIs da conta + funil + scorecard congelados no run — a faixa do site lê daqui.
    metricsSnapshot: jsonb("metrics_snapshot").$type<Record<string, unknown>>(),
    traceId: text("trace_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("agent_runs_agent_idx").on(t.agentId), index("agent_runs_org_idx").on(t.orgId)],
);

/** Passo do grafo dentro de um run (nó LangGraph). */
export const agentRunSteps = pgTable(
  "agent_run_steps",
  {
    id: pk(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: runStatus("status").notNull().default("pending"),
    input: jsonb("input").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [index("agent_run_steps_run_idx").on(t.runId)],
);

/**
 * Chamada de tool (escrita na Meta). `idempotency_key` = nunca aplica a mesma
 * mutação 2x. `before_state` = rollback.
 */
export const agentToolCalls = pgTable(
  "agent_tool_calls",
  {
    id: pk(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    toolKey: text("tool_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    risk: riskLevel("risk").notNull().default("low"),
    args: jsonb("args").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    // snapshot pré-mutação p/ rollback
    beforeState: jsonb("before_state").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [index("agent_tool_calls_run_idx").on(t.runId)],
);

/** Pedido de OK humano (HITL) p/ uma ou mais ações. Expira em 24h. */
export const approvals = pgTable(
  "approvals",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    status: approvalStatus("status").notNull().default("pending"),
    payloadActions: jsonb("payload_actions").$type<Action[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("approvals_org_idx").on(t.orgId), index("approvals_run_idx").on(t.runId)],
);

/** Achado/sugestão do run (com feedback + outcome). */
export const recommendations = pgTable(
  "recommendations",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    rationale: text("rationale"),
    proposedAction: jsonb("proposed_action").$type<Action>(),
    riskLevel: riskLevel("risk_level").notNull().default("low"),
    status: recommendationStatus("status").notNull().default("open"),
    ...timestamps,
  },
  (t) => [index("recommendations_run_idx").on(t.runId)],
);

/** Feedback + outcome tracking (instrumento de validação). */
export const recommendationFeedback = pgTable(
  "recommendation_feedback",
  {
    id: pk(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    vote: feedbackVote("vote"),
    // resultado observado após aplicar (positivo/negativo/neutro)
    outcome: outcomeStatus("outcome").notNull().default("pending"),
    outcomeMetrics: jsonb("outcome_metrics").$type<Record<string, unknown>>(),
    note: text("note"),
    measuredAt: timestamp("measured_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("recommendation_feedback_rec_idx").on(t.recommendationId)],
);
