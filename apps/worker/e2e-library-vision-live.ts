/** Live: caminho de VISÃO da biblioteca (imagem). Sobe uma imagem real → StoragePort → Meta,
 *  roda a lógica do consumer (blob → data-url → resolver de visão → cache) e confere que a
 *  descrição saiu + cacheou. Limpa o asset+blob no fim. Token do banco. 1 chamada de visão. */
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { creativeAssets } from "@trafego/db";
import { ingestCreativeImage } from "@trafego/creative-library";
import type { AdAccountRef } from "@trafego/shared/ports";
import { buildComposition } from "./src/composition.js";
import { createAnalysisRepo } from "./src/modules/analysis/repo.js";
import { createVisionResolver, creativeContentHash } from "./src/modules/vision/resolver.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";
const IMG = process.env["E2E_IMG"] ?? "../../apps/web/public/android-chrome-512x512.png";

async function main() {
  const deps = await buildComposition();
  const { db, ports } = deps;
  const repo = createAnalysisRepo(db);
  const account = await repo.loadAccount(ORG, ACC);
  if (!account) throw new Error("conta não encontrada");
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken: ports.vault.decrypt(account.tokenCripto) };

  const bytes = new Uint8Array(readFileSync(IMG));
  console.log("▶ subindo imagem de teste (logo) → Meta + storage…");
  const { assetId, metaImageHash } = await ingestCreativeImage(
    { db, storage: ports.storage, ads: ports.ads },
    { orgId: ORG, adAccountId: ACC, ref, bytes, contentType: "image/png", filename: `e2e-vision-${Date.now()}.png` },
  );
  console.log("  asset:", assetId, "image_hash:", metaImageHash ? "ok" : "—");

  try {
    // === lógica do consumer creative-analyze (imagem) ===
    const [row] = await db.select({ storageRef: creativeAssets.storageRef }).from(creativeAssets).where(eq(creativeAssets.id, assetId)).limit(1);
    const blob = await ports.storage.get(row!.storageRef!);
    if (!blob) throw new Error("blob não encontrado");
    const dataUrl = `data:${blob.contentType};base64,${Buffer.from(blob.bytes).toString("base64")}`;
    const vision = createVisionResolver({ db, llm: ports.llm, model: deps.analysis.visionModel, analyzerVersion: deps.visionAnalyzerVersion, logger: deps.logger });
    const contentHash = creativeContentHash(assetId, undefined);
    console.log("▶ analisando visão (data-url do blob → LLM)…");
    const result = await vision.resolve({ creativeId: assetId, imageUrls: [dataUrl], contentHash });
    console.log("  resultado:", JSON.stringify(result)?.slice(0, 320));

    // confere o cache (persistido por contentHash+versão).
    const hit = await db.execute(sql`SELECT 1 FROM creative_vision_analyses WHERE content_hash = ${contentHash} AND analyzer_version = ${deps.visionAnalyzerVersion} LIMIT 1`);
    const rows = (hit as unknown as { rows?: unknown[] }).rows ?? (hit as unknown as unknown[]);
    console.log("  cacheado:", Array.isArray(rows) && rows.length === 1 ? "✅ sim" : "❌ não");
    console.log(result ? "  ✅ visão retornou descrição (data-url do blob funcionou)" : "  ❌ visão retornou null");
  } finally {
    // cleanup: blob + linha (o adimage na Meta é inócuo — não veicula, não gasta).
    const [row] = await db.select({ storageRef: creativeAssets.storageRef }).from(creativeAssets).where(eq(creativeAssets.id, assetId)).limit(1);
    if (row?.storageRef) await ports.storage.delete(row.storageRef).catch(() => undefined);
    await db.delete(creativeAssets).where(and(eq(creativeAssets.id, assetId), eq(creativeAssets.orgId, ORG)));
    console.log("  ↩ asset + blob limpos.");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
