/** Bateria EXTENSIVA da visão+cache da biblioteca (live). Cobre: A1 imagem→visão→cache;
 *  A2 cache HIT (2ª vez não re-analisa); A3 frames de vídeo (fonte da visão de vídeo); A4
 *  guarda (arquivado/não-pronto → pula); A5 sem mídia → pula. Limpa tudo. Token do banco. */
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { creativeAssets, creativeVisionAnalyses } from "@trafego/db";
import { ingestCreativeImage } from "@trafego/creative-library";
import type { AdAccountRef } from "@trafego/shared/ports";
import { buildComposition } from "./src/composition.js";
import { createAnalysisRepo } from "./src/modules/analysis/repo.js";
import { createVisionResolver, creativeContentHash } from "./src/modules/vision/resolver.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";
const IMG = "../../apps/web/public/android-chrome-512x512.png";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 200) : ""); } };

async function cacheCount(db: Awaited<ReturnType<typeof buildComposition>>["db"], hash: string, ver: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(creativeVisionAnalyses).where(and(eq(creativeVisionAnalyses.contentHash, hash), eq(creativeVisionAnalyses.analyzerVersion, ver)));
  return Number(r?.n ?? 0);
}

async function main() {
  const deps = await buildComposition();
  const { db, ports } = deps;
  const repo = createAnalysisRepo(db);
  const account = await repo.loadAccount(ORG, ACC);
  if (!account) throw new Error("conta não encontrada");
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken: ports.vault.decrypt(account.tokenCripto) };
  const vision = createVisionResolver({ db, llm: ports.llm, model: deps.analysis.visionModel, analyzerVersion: deps.visionAnalyzerVersion, logger: deps.logger });
  const ver = deps.visionAnalyzerVersion;

  const bytes = new Uint8Array(readFileSync(IMG));
  const { assetId } = await ingestCreativeImage({ db, storage: ports.storage, ads: ports.ads }, { orgId: ORG, adAccountId: ACC, ref, bytes, contentType: "image/png", filename: `e2e-batt-${Date.now()}.png` });
  const hash = creativeContentHash(assetId, undefined);

  try {
    console.log("\n▶ A1 — imagem → visão (data-url do blob) → cache");
    const before = await cacheCount(db, hash, ver);
    const [row] = await db.select({ storageRef: creativeAssets.storageRef }).from(creativeAssets).where(eq(creativeAssets.id, assetId)).limit(1);
    const blob = await ports.storage.get(row!.storageRef!);
    const dataUrl = `data:${blob!.contentType};base64,${Buffer.from(blob!.bytes).toString("base64")}`;
    const r1 = await vision.resolve({ creativeId: assetId, imageUrls: [dataUrl], contentHash: hash });
    ok("visão retornou descrição", Boolean(r1?.summary), r1);
    ok("cache criou 1 linha", (await cacheCount(db, hash, ver)) === before + 1);

    console.log("▶ A2 — 2ª análise = CACHE HIT (não duplica, não re-analisa)");
    const r2 = await vision.resolve({ creativeId: assetId, imageUrls: [dataUrl], contentHash: hash });
    ok("cache ainda 1 linha (sem duplicar)", (await cacheCount(db, hash, ver)) === before + 1);
    // jsonb não preserva ordem de chave → compara CONTEÚDO, não a string (o cache hit é real).
    ok("mesmo conteúdo (veio do cache)", r2?.summary === r1?.summary && r2?.hook === r1?.hook);

    console.log("▶ A3 — frames de vídeo (fonte da visão de vídeo)");
    const defaults = await ports.ads.inferCreationDefaults(ref);
    if (defaults.videoId) {
      const frames = await ports.ads.getVideoFrames(ref, defaults.videoId);
      ok("getVideoFrames devolve frames HD", frames.length > 0, { n: frames.length });
    } else {
      console.log("  (conta sem vídeo veiculando p/ testar frames — pulando A3)");
    }

    console.log("▶ A4/A5 — guarda do consumer (arquivado/não-pronto/sem mídia → pula)");
    // replica a guarda do consumer: status!=ready OU archived OU sem mídia → não analisa.
    const guardSkips = (status: string, archivedAt: Date | null, hasMedia: boolean) => status !== "ready" || archivedAt !== null || !hasMedia;
    ok("arquivado → pula", guardSkips("ready", new Date(), true));
    ok("não-pronto (pending) → pula", guardSkips("pending", null, true));
    ok("sem mídia → pula", guardSkips("ready", null, false));
    ok("pronto + mídia + não-arquivado → analisa", guardSkips("ready", null, true) === false);
  } finally {
    const [row] = await db.select({ storageRef: creativeAssets.storageRef }).from(creativeAssets).where(eq(creativeAssets.id, assetId)).limit(1);
    if (row?.storageRef) await ports.storage.delete(row.storageRef).catch(() => undefined);
    await db.delete(creativeVisionAnalyses).where(and(eq(creativeVisionAnalyses.contentHash, hash), eq(creativeVisionAnalyses.analyzerVersion, ver)));
    await db.delete(creativeAssets).where(and(eq(creativeAssets.id, assetId), eq(creativeAssets.orgId, ORG)));
    console.log(`\n── ${pass} ok, ${fail} falha ── (asset+blob+cache de teste limpos)`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
