import { date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { StoredInsightMetrics } from "@trafego/shared";
import { entityLevel, pk, timestamps } from "./_shared.js";
import { adAccounts } from "./integrations.js";
import { orgs } from "./tenancy.js";

/**
 * Série temporal de métricas Meta (retenção rolante ~90d por env).
 * Sync incremental — nunca re-baixa histórico (ver Governor, §7).
 */
export const insightsSnapshots = pgTable(
  "insights_snapshots",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    entityLevel: entityLevel("entity_level").notNull(),
    entityId: text("entity_id").notNull(),
    date: date("date").notNull(),
    metricsJson: jsonb("metrics_json").$type<StoredInsightMetrics>().notNull(),
    ...timestamps,
  },
  (t) => [
    index("insights_snapshots_account_idx").on(t.adAccountId),
    // idempotência do sync: 1 linha por (conta, entidade, dia)
    uniqueIndex("insights_snapshots_unique_idx").on(
      t.adAccountId,
      t.entityId,
      t.date,
    ),
  ],
);
