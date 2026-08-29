import { boolean, doublePrecision, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared.js";
import { adAccounts } from "./integrations.js";
import { orgs } from "./tenancy.js";

/**
 * Cache dos custom/saved audiences da conta (Fatia 7) — populado pela análise completa e lido
 * pelo chat DB-first (Meta só no fallback, evita rate limit). O agente parava de CHUTAR público;
 * agora propõe/segmenta com os públicos REAIS. 1 linha viva por (conta, público externo).
 */
export const customAudiences = pgTable(
  "custom_audiences",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    /** id do público na plataforma (Meta). */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    /** subtipo neutro (custom|lookalike|website|engagement…) — vocabulário Meta fica no adapter. */
    subtype: text("subtype"),
    approximateCount: doublePrecision("approximate_count"),
    isLookalike: boolean("is_lookalike").notNull().default(false),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("custom_audiences_account_idx").on(t.adAccountId),
    uniqueIndex("custom_audiences_unique_idx").on(t.adAccountId, t.externalId),
  ],
);
