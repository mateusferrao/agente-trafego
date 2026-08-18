import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Helpers compartilhados entre grupos de schema.
 * Convenção: PK uuid (defaultRandom), timestamps `created_at`/`updated_at`.
 */

/** Colunas de timestamp padrão em (quase) toda tabela. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** PK uuid padrão. */
export const pk = () => uuid("id").primaryKey().defaultRandom();

// ─── Enums de domínio (reusados em vários grupos) ────────────────────────
export const membershipRole = pgEnum("membership_role", ["owner", "member"]);
// Status de acesso ao produto (gate). Nomes duráveis pós-beta: `active` = pode
// usar; `pending` = aguardando liberação; `revoked` = acesso removido.
export const accessStatus = pgEnum("access_status", ["pending", "active", "revoked"]);
export const tokenStatus = pgEnum("token_status", ["valid", "invalid", "unchecked"]);
export const channelStatus = pgEnum("channel_status", [
  "disconnected",
  "connecting",
  "connected",
]);
export const contactRole = pgEnum("contact_role", ["owner", "member"]);

export const entityLevel = pgEnum("entity_level", ["account", "campaign", "adset", "ad"]);
export const entityStatus = pgEnum("entity_status", [
  "active",
  "paused",
  "deleted",
  "archived",
]);

export const actionType = pgEnum("action_type", [
  "pause_entity",
  "resume_entity",
  "adjust_budget",
  "set_status",
]);
export const actionSource = pgEnum("action_source", ["playbook", "llm"]);
export const riskLevel = pgEnum("risk_level", ["low", "medium", "high"]);
export const autonomyLevel = pgEnum("autonomy_level", [
  "notify",
  "suggest",
  "act_safe",
  "act_full",
]);

export const agentStatus = pgEnum("agent_status", ["active", "paused", "draft"]);
export const toolBindingMode = pgEnum("tool_binding_mode", ["enabled", "disabled", "shadow"]);
export const memoryType = pgEnum("memory_type", ["objective", "past_action", "rejected", "fact"]);
export const memoryLifecycle = pgEnum("memory_lifecycle", ["active", "stale", "archived"]);

export const runTrigger = pgEnum("run_trigger", ["cron", "on_demand", "conversation"]);
export const runStatus = pgEnum("run_status", [
  "pending",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "partial",
]);
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);
export const recommendationStatus = pgEnum("recommendation_status", [
  "open",
  "applied",
  "dismissed",
  "expired",
]);
export const feedbackVote = pgEnum("feedback_vote", ["up", "down"]);
export const outcomeStatus = pgEnum("outcome_status", ["pending", "positive", "negative", "neutral"]);

export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
