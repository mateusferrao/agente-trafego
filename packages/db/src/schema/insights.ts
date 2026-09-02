import { date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { BreakdownSegment, ConversionGoal, EntityConfigSnapshot, StoredInsightMetrics } from "@trafego/shared";
import { breakdownDimension, entityLevel, pk, timestamps } from "./_shared.js";
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
 * Breakdown demográfico/posicionamento (S7, pivô saúde) — cadência PRÓPRIA, mais lenta
 * que o sync diário (`insights_snapshots`): guarda só o MAIS RECENTE por (conta, entidade,
 * dimensão), upsert (nunca historiza por dia — o spread demográfico muda devagar). `date`
 * é o carimbo de frescor explícito (nunca implica frescor do dia — a NOTE do kernel precisa
 * dele, senão o LLM citaria um padrão de N dias atrás como se fosse de hoje).
 */
export const insightsBreakdowns = pgTable(
  "insights_breakdowns",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    // S7: só "account"|"campaign" (adset/ad é fast-follow, ver ROADMAP) — reusa o enum
    // genérico de 4 níveis (sem enum próprio de 2 valores).
    entityLevel: entityLevel("entity_level").notNull(),
    entityId: text("entity_id").notNull(),
    dimension: breakdownDimension("dimension").notNull(),
    segments: jsonb("segments").$type<readonly BreakdownSegment[]>().notNull(),
    date: date("date").notNull(),
    ...timestamps,
  },
  (t) => [
    index("insights_breakdowns_account_idx").on(t.adAccountId),
    // upsert: 1 linha por (conta, entidade, dimensão) — só o mais recente sobrevive.
    uniqueIndex("insights_breakdowns_unique_idx").on(t.adAccountId, t.entityId, t.dimension),
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

/**
 * Snapshot da CONFIG de uma entidade por dia (aprendizado contínuo, S4) — orçamento/status.
 * `insights_snapshots` guarda MÉTRICA, não config; esta série é o que permite detectar
 * mudança de config feita pela org na mão na Meta (fora das nossas ações), pra atribuir
 * outcome a ela. Escrita no `record` da análise (cadência da análise; sem chamada Meta
 * extra — a config já vem em `state.entities`). Upsert 1 linha por (conta, entidade, dia).
 */
export const entityConfigSnapshots = pgTable(
  "entity_config_snapshots",
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
    // { status, dailyBudgetMinor?, lifetimeBudgetMinor? } — unidade MENOR da moeda.
    configJson: jsonb("config_json").$type<EntityConfigSnapshot>().notNull(),
    ...timestamps,
  },
  (t) => [
    index("entity_config_snapshots_account_idx").on(t.adAccountId),
    uniqueIndex("entity_config_snapshots_unique_idx").on(t.adAccountId, t.entityId, t.date),
  ],
);
