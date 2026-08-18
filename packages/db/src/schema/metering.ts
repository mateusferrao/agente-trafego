import { index, integer, jsonb, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared.js";
import { orgs } from "./tenancy.js";
import { agentRuns } from "./execution.js";

/**
 * Metering genérico (type + payload_json) → novas dimensões de uso/cobrança
 * sem migração. Base do billing (mensalidade + markup). Ver MeteringPort.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    // custo real do provider (OpenRouter retorna)
    cost: numeric("cost", { precision: 12, scale: 6 }),
    ...timestamps,
  },
  (t) => [
    index("usage_events_org_idx").on(t.orgId),
    index("usage_events_type_idx").on(t.type),
  ],
);
