import { boolean, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { pk, riskLevel, timestamps, toolBindingMode } from "./_shared.js";
import { agents } from "./agents.js";
import { orgs } from "./tenancy.js";

/**
 * Catálogo-DB de ferramentas do agente. Global (não `org`-scoped):
 * habilitado por org/agente via `agent_tool_bindings`.
 */
export const agentToolDefinitions = pgTable("agent_tool_definitions", {
  id: pk(),
  key: text("key").notNull().unique(),
  description: text("description"),
  riskLevel: riskLevel("risk_level").notNull().default("low"),
  isIdempotent: boolean("is_idempotent").notNull().default(true),
  // JSON schema dos args (zod → json schema)
  schema: jsonb("schema").$type<Record<string, unknown>>().notNull().default({}),
  requiredPermission: text("required_permission"),
  requiredEntitlement: text("required_entitlement"),
  ...timestamps,
});

/** Habilita/desabilita uma tool para um agente (mode: enabled|disabled|shadow). */
export const agentToolBindings = pgTable(
  "agent_tool_bindings",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolKey: text("tool_key")
      .notNull()
      .references(() => agentToolDefinitions.key, { onDelete: "cascade" }),
    mode: toolBindingMode("mode").notNull().default("enabled"),
    ...timestamps,
  },
  (t) => [index("agent_tool_bindings_agent_idx").on(t.agentId)],
);
