/** (A) publish live: criar do zero reusando o CRIATIVO DE VÍDEO vencedor + copy aterrada,
 *  PAUSED, e reverter. Prova o caminho de vídeo do runFromScratchSaga (createAdCreative com
 *  videoId + createAd). Token via E2E_META_TOKEN (nunca logado). */
import { eq } from "drizzle-orm";
import { adAccounts } from "@trafego/db";
import { MetaGraphClient } from "@trafego/ads-meta";
import type { AdAccountRef } from "@trafego/shared/ports";
import { buildComposition } from "./src/composition.js";
import { generateCopy } from "./src/modules/copy/generate-copy.js";

const ACC = process.env["E2E_ACCOUNT_ID"] ?? "d246db5c-d843-4519-a588-9197131458c4";
const DAILY = 2000;
const created: { label: string; id: string }[] = [];

async function main() {
  const { db, ports } = await buildComposition();
  const [row] = await db.select({ meta: adAccounts.adAccountId }).from(adAccounts).where(eq(adAccounts.id, ACC)).limit(1);
  const token = process.env["E2E_META_TOKEN"];
  if (!row || !token) throw new Error("conta/token ausente");
  const ref: AdAccountRef = { adAccountId: row.meta, accessToken: token };
  const raw = new MetaGraphClient({});

  try {
    const d = await ports.ads.inferCreationDefaults(ref);
    console.log("defaults:", JSON.stringify({ hasVideo: !!d.videoId, hasImage: !!d.imageHash, page: !!d.pageId, goal: d.objectiveGoal }));
    if (!d.pageId || !d.videoId) { console.log("conta sem vídeo/página inferível → nada a testar"); return; }
    const copy = await generateCopy(ports.llm, { model: "openai/gpt-4o-mini", goal: d.objectiveGoal ?? "lead", variantsCount: 1, ...(d.winnerCopy ? { winnerCopy: d.winnerCopy } : {}) }, { adAccountId: ACC });
    const v = copy[0]!;

    const { campaignId } = await ports.ads.createCampaign(ref, { name: `E2E video ${Date.now()}`, objectiveGoal: d.objectiveGoal ?? "lead", specialAdCategories: [], status: "paused" });
    created.push({ label: "campaign", id: campaignId });
    const { adsetId } = await ports.ads.createAdSet(ref, { campaignId, name: "conjunto", dailyBudgetMinor: DAILY, goal: d.objectiveGoal ?? "lead", ...(d.pixelId ? { pixelId: d.pixelId } : {}), targeting: { kind: "advantage_plus" }, status: "paused" });
    created.push({ label: "adset", id: adsetId });
    const { creativeId } = await ports.ads.createAdCreative(ref, { name: "criativo", pageId: d.pageId, videoId: d.videoId, ...(d.linkUrl ? { linkUrl: d.linkUrl } : {}), copy: { primaryText: v.primaryText, headline: v.headline, ...(v.description ? { description: v.description } : {}), ...(v.cta ? { cta: v.cta } : {}) } });
    created.push({ label: "creative", id: creativeId });
    const { adId } = await ports.ads.createAd(ref, { adsetId, creativeId, name: "anuncio", status: "paused" });
    created.push({ label: "ad", id: adId });
    console.log("✅ criado do zero com VÍDEO reusado (PAUSED):", JSON.stringify({ campaignId, adsetId, creativeId, adId }));
  } finally {
    for (const { label, id } of [...created].reverse()) {
      try { await raw.request({ method: "DELETE", path: id, accessToken: token! }); console.log(`  ↩ deletado ${label} ${id}`); }
      catch (e) { console.log(`  ⚠ falha ao deletar ${label} ${id}: ${String(e).split("\n")[0]}`); }
    }
    console.log("revert concluído.");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
