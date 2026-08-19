import { date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ConversionGoal, StoredInsightMetrics } from "@trafego/shared";
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

/**
 * Rótulos legíveis de conversão por conta (id → nome). Genérico multi-plataforma
 * (`platform` como coluna): o worker resolve os nomes durante o run (ex: conversões
 * personalizadas da Meta) e faz upsert aqui; a API/config lê SÓ o banco — sem
 * chamada à plataforma numa tela de config. Convenção: sem id personalizado →
 * `custom_conversion_id = ''` (mantém a unique/upsert simples com goal padrão).
 */
export const conversionLabels = pgTable(
  "conversion_labels",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    goal: text("goal").$type<ConversionGoal>().notNull(),
    customConversionId: text("custom_conversion_id").notNull().default(""),
    label: text("label").notNull(),
    ...timestamps,
  },
  (t) => [
    index("conversion_labels_account_idx").on(t.adAccountId),
    uniqueIndex("conversion_labels_unique_idx").on(t.adAccountId, t.goal, t.customConversionId),
  ],
);
