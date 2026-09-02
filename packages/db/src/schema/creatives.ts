import { doublePrecision, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PerformanceTier, WhatsappSource } from "@trafego/shared";
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
    // nome do ANÚNCIO no Ads Manager (ex: "TESTE Videos 2 - v3") — DIFERENTE de `title`
    // (headline da copy). Já vinha da Meta (`Creative.name`) e era descartado.
    name: text("name"),
    // copy real (o que faltava): texto principal, título/headline, CTA.
    body: text("body"),
    title: text("title"),
    callToAction: text("call_to_action"),
    // mídia (opcional) p/ preview + reuse na criação (Fatia 7).
    imageUrl: text("image_url"),
    /** hash estável da imagem → reusar anúncio de IMAGEM ao vivo no picker (Slice 12). */
    imageHash: text("image_hash"),
    thumbnailUrl: text("thumbnail_url"),
    videoId: text("video_id"),
    // destino de WhatsApp do CTA (Fatia 7) + origem (honestidade): resolvido no run a
    // partir do `call_to_action.value`. Cache p/ o chat responder "qual o número?" sem
    // chamar a Meta (DB-first; live no fallback). Hierarquia (`campaign_id`/`adset_id`)
    // resolve o número por-campanha — antes ausente em ad_creatives.
    whatsappNumber: text("whatsapp_number"),
    whatsappSource: text("whatsapp_source").$type<WhatsappSource>(),
    campaignId: text("campaign_id"),
    adsetId: text("adset_id"),
    // desempenho DENORMALIZADO do run (ranking "campeã" sem join): tier + métricas.
    // doublePrecision (não real/float4): `spend` é exibido ao usuário — real perderia
    // centavos em contas de gasto alto (§13 sem número enganoso).
    tier: text("tier").$type<PerformanceTier>(),
    spend: doublePrecision("spend"),
    cpa: doublePrecision("cpa"),
    roas: doublePrecision("roas"),
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
