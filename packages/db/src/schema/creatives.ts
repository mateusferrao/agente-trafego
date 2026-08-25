import { index, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PerformanceTier } from "@trafego/shared";
import { pk, timestamps } from "./_shared.js";
import { agentRuns } from "./execution.js";
import { adAccounts } from "./integrations.js";
import { orgs } from "./tenancy.js";

/**
 * Copy dos anúncios (texto principal/título/CTA) persistida do run — antes era
 * ingerida da Meta e DESCARTADA após alimentar a visão. Guarda 1 linha viva por
 * anúncio (`(adAccountId, adId)` único) com o desempenho **denormalizado** do
 * próprio run (tier/CPA/ROAS/gasto) p/ responder "qual minha copy campeã" sem
 * join tardio. Alimenta a análise (bloco `copyByAdId` no prompt) e o chat
 * (read-tool `get_top_creatives`), e é reidratada pela busca em tempo real.
 */
export const adCreatives = pgTable(
  "ad_creatives",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    adId: text("ad_id").notNull(),
    creativeId: text("creative_id"),
    // copy real (o que faltava): texto principal, título/headline, CTA.
    body: text("body"),
    title: text("title"),
    callToAction: text("call_to_action"),
    // mídia (opcional) p/ preview futuro.
    imageUrl: text("image_url"),
    thumbnailUrl: text("thumbnail_url"),
    videoId: text("video_id"),
    // desempenho DENORMALIZADO do run (ranking "campeã" sem join): tier + métricas.
    tier: text("tier").$type<PerformanceTier>(),
    spend: real("spend"),
    cpa: real("cpa"),
    roas: real("roas"),
    // proveniência temporal: instante da captura + run que a produziu (soft-ref).
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("ad_creatives_account_idx").on(t.adAccountId),
    // 1 linha viva por anúncio — upsert idempotente por-anúncio (historização = fast-follow).
    uniqueIndex("ad_creatives_unique_idx").on(t.adAccountId, t.adId),
  ],
);
