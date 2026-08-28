/** (A) live: inferCreationDefaults ESCOLHE o melhor criativo veiculando + devolve winnerCopy;
 *  generateCopy aterra na copy do vencedor. Token via E2E_META_TOKEN (nunca logado). Só reads. */
import { eq } from "drizzle-orm";
import { adAccounts } from "@trafego/db";
import type { AdAccountRef } from "@trafego/shared/ports";
import { buildComposition } from "./src/composition.js";
import { generateCopy } from "./src/modules/copy/generate-copy.js";

const ACC = process.env["E2E_ACCOUNT_ID"] ?? "d246db5c-d843-4519-a588-9197131458c4";

async function main() {
  const { db, ports } = await buildComposition();
  const [row] = await db.select({ meta: adAccounts.adAccountId }).from(adAccounts).where(eq(adAccounts.id, ACC)).limit(1);
  if (!row) throw new Error("conta não encontrada");
  const token = process.env["E2E_META_TOKEN"];
  if (!token) throw new Error("E2E_META_TOKEN ausente");
  const ref: AdAccountRef = { adAccountId: row.meta, accessToken: token };

  const d = await ports.ads.inferCreationDefaults(ref);
  console.log("▶ defaults inferidos (melhor criativo veiculando):", JSON.stringify({
    sourceAdId: d.sourceAdId,
    format: d.videoId ? "video" : d.imageHash ? "image" : "nenhum",
    hasImageHash: Boolean(d.imageHash),
    hasVideoId: Boolean(d.videoId),
    pageId: d.pageId ? "sim" : "NÃO",
    pixelId: d.pixelId ? "sim" : "não",
    objectiveGoal: d.objectiveGoal ?? null,
    winnerCopyCount: d.winnerCopy?.length ?? 0,
  }, null, 2));
  console.log("▶ winnerCopy (o que já performa — aterramento):", JSON.stringify(d.winnerCopy ?? [], null, 2));

  if (!d.winnerCopy || d.winnerCopy.length === 0) {
    console.log("⚠ sem winnerCopy — geração cairia genérica (conta sem copy nos ativos?)");
  }
  const copy = await generateCopy(
    ports.llm,
    { model: process.env["E2E_COPY_MODEL"] ?? "openai/gpt-4o-mini", goal: d.objectiveGoal ?? "purchase", variantsCount: 2, ...(d.winnerCopy ? { winnerCopy: d.winnerCopy } : {}) },
    { adAccountId: ACC },
  );
  console.log("▶ copy gerada (aterrada no vencedor):", JSON.stringify(copy, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 2).join(" | ")); process.exit(1); });
