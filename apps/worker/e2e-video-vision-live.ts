/** Live: cadeia de visão de VÍDEO (frames Meta → resolver → descrição + cache) usando o vídeo
 *  REAL da conta. Prova a parte nova do caminho de vídeo da biblioteca. Limpa o cache de teste. */
import { and, eq } from "drizzle-orm";
import { creativeVisionAnalyses } from "@trafego/db";
import type { AdAccountRef } from "@trafego/shared/ports";
import { buildComposition } from "./src/composition.js";
import { createAnalysisRepo } from "./src/modules/analysis/repo.js";
import { createVisionResolver, creativeContentHash } from "./src/modules/vision/resolver.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";
const TEST_KEY = `e2e-video-vision-${Date.now()}`;

async function main() {
  const deps = await buildComposition();
  const { db, ports } = deps;
  const account = await createAnalysisRepo(db).loadAccount(ORG, ACC);
  if (!account) throw new Error("conta não encontrada");
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken: ports.vault.decrypt(account.tokenCripto) };

  const defaults = await ports.ads.inferCreationDefaults(ref);
  if (!defaults.videoId) { console.log("conta sem vídeo veiculando — nada a testar"); return; }
  console.log("videoId real:", defaults.videoId);

  const frames = await ports.ads.getVideoFrames(ref, defaults.videoId);
  console.log("frames HD:", frames.length);
  if (frames.length === 0) { console.log("❌ sem frames"); process.exit(1); }

  const vision = createVisionResolver({ db, llm: ports.llm, model: deps.analysis.visionModel, analyzerVersion: deps.visionAnalyzerVersion, logger: deps.logger });
  const hash = creativeContentHash(TEST_KEY, undefined);
  try {
    console.log("▶ analisando o vídeo pelos frames (data-url NÃO — URLs Meta) → LLM…");
    const r = await vision.resolve({ creativeId: TEST_KEY, imageUrls: frames, contentHash: hash });
    console.log("resultado:", JSON.stringify(r)?.slice(0, 360));
    console.log(r?.summary ? "✅ visão de VÍDEO retornou descrição (frames Meta funcionaram)" : "❌ null");
  } finally {
    await db.delete(creativeVisionAnalyses).where(and(eq(creativeVisionAnalyses.contentHash, hash), eq(creativeVisionAnalyses.analyzerVersion, deps.visionAnalyzerVersion)));
    console.log("↩ cache de teste limpo.");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
