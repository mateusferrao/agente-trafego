/**
 * E2E REAL da Fatia 7 — credenciais reais do .env (LLM OpenRouter + Meta Graph).
 * Conta: BM - Automato. TUDO criado nasce PAUSED (nunca veicula/gasta) e é DELETADO no
 * fim (revert). Só SELECT no DB (lê a conta+token); não escreve no banco.
 *
 * Rodar: pnpm --filter @trafego/worker exec tsx --env-file=../../.env e2e-real-fatia7.ts
 */
import { eq } from "drizzle-orm";
import { adAccounts, platformConnections } from "@trafego/db";
import { resolveMetaObjective, resolveAdSetConversion, resolveMetaCta, MetaGraphClient } from "@trafego/ads-meta";
import type { AdAccountRef } from "@trafego/shared/ports";
import { buildComposition } from "./src/composition.js";
import { generateCopy } from "./src/modules/copy/generate-copy.js";

const BM_AUTOMATO_ACCOUNT_ID = process.env["E2E_ACCOUNT_ID"] ?? "d246db5c-d843-4519-a588-9197131458c4";
const COPY_MODEL = process.env["E2E_COPY_MODEL"] ?? "openai/gpt-4o-mini";
const DAILY_BUDGET_MINOR = 1000; // R$10/dia — acima do minimo da conta; PAUSED, nunca gasta.

const created: { label: string; id: string }[] = [];
function log(step: string, data?: unknown) {
  console.log(`\n▶ ${step}`, data !== undefined ? JSON.stringify(data, null, 2) : "");
}

async function main() {
  const deps = await buildComposition();
  const { db, ports } = deps;
  const rawClient = new MetaGraphClient({});
  let ref!: AdAccountRef;

  try {
    const [row] = await db
      .select({
        metaAdAccountId: adAccounts.adAccountId,
        currency: adAccounts.currency,
        accToken: adAccounts.tokenCripto,
        connToken: platformConnections.tokenCripto,
      })
      .from(adAccounts)
      .leftJoin(platformConnections, eq(adAccounts.connectionId, platformConnections.id))
      .where(eq(adAccounts.id, BM_AUTOMATO_ACCOUNT_ID))
      .limit(1);
    if (!row) throw new Error("conta BM Automato não encontrada");
    // Override opcional por env (E2E_META_TOKEN): permite rodar com um token FRESCO sem
    // regravar o banco. Nunca é logado. Ausente → usa o token cripto do DB (fluxo normal).
    const overrideToken = process.env["E2E_META_TOKEN"];
    const token = overrideToken && overrideToken.length > 0 ? overrideToken : ports.vault.decrypt((row.connToken ?? row.accToken)!);
    log("token", { fonte: overrideToken ? "env override (E2E_META_TOKEN)" : "banco (cripto)" });
    ref = { adAccountId: row.metaAdAccountId, accessToken: token };
    log("conta resolvida", { metaAdAccountId: row.metaAdAccountId, currency: row.currency });

    // 2) COPY REAL (OpenRouter).
    const copy = await generateCopy(
      ports.llm,
      { model: COPY_MODEL, goal: "purchase", variantsCount: 2, businessContext: "Clínica de estética; foco em agendamentos de avaliação." },
      { adAccountId: BM_AUTOMATO_ACCOUNT_ID },
    );
    log("copy gerada (real)", copy);
    if (copy.length === 0) throw new Error("generateCopy retornou vazio");

    // 3) inferCreationDefaults reais.
    const defaults = await ports.ads.inferCreationDefaults(ref);
    log("defaults inferidos", defaults);

    // 4) CRIAR DO ZERO (saga real, PAUSED).
    if (defaults.pageId) {
      const goal = defaults.objectiveGoal ?? "purchase";
      const name = `E2E Fatia7 ${Date.now()} — do zero`;
      const { campaignId } = await ports.ads.createCampaign(ref, { name, objectiveGoal: goal, specialAdCategories: [], status: "paused" });
      created.push({ label: "campaign(from_scratch)", id: campaignId });
      log("campanha criada", { campaignId, objective: resolveMetaObjective(goal) });

      const { adsetId } = await ports.ads.createAdSet(ref, {
        campaignId,
        name: `${name} — conjunto`,
        dailyBudgetMinor: DAILY_BUDGET_MINOR,
        goal,
        ...(defaults.pixelId ? { pixelId: defaults.pixelId } : {}),
        targeting: { kind: "advantage_plus" },
        status: "paused",
      });
      created.push({ label: "adset(from_scratch)", id: adsetId });
      log("adset criado", { adsetId, conv: resolveAdSetConversion(goal, defaults.pixelId) });

      if (defaults.imageHash) {
        const v = copy[0]!;
        const { creativeId } = await ports.ads.createAdCreative(ref, {
          name: `${name} — criativo`,
          pageId: defaults.pageId,
          imageHash: defaults.imageHash,
          ...(defaults.linkUrl ? { linkUrl: defaults.linkUrl } : {}),
          copy: { primaryText: v.primaryText, headline: v.headline, ...(v.cta ? { cta: v.cta } : {}) },
        });
        created.push({ label: "adcreative", id: creativeId });
        log("criativo criado", { creativeId, cta: resolveMetaCta(v.cta) });

        const { adId } = await ports.ads.createAd(ref, { adsetId, creativeId, name: `${name} — anúncio`, status: "paused" });
        created.push({ label: "ad", id: adId });
        log("anúncio criado (PENDING_REVIEW ao aprovar)", { adId });
      } else {
        log("SEM image_hash inferível → pulei criativo/anúncio (caminho triste esperado)");
      }
    } else {
      log("SEM Page inferível → criar-do-zero bloqueado (caminho triste esperado)");
    }

    // 5) DUPLICAR/ESCALAR (real /copies, PAUSED).
    const adsets = await ports.ads.listEntities(ref, "adset");
    const source = adsets.find((a) => a.id && !created.some((c) => c.id === a.id));
    if (source) {
      const dup = await ports.ads.duplicateEntity(ref, { sourceLevel: "adset", sourceId: source.id, status: "paused", renameSuffix: "E2E escala" });
      created.push({ label: "duplicated_adset", id: dup.copiedId });
      log("adset duplicado (real /copies, PAUSED)", { source: source.id, copied: dup.copiedId, children: dup.childIds });
      await ports.ads.setEntityBudget(ref, dup.copiedId, DAILY_BUDGET_MINOR * 2);
      log("budget da cópia ajustado (escala)", { copiedId: dup.copiedId, dailyBudgetMinor: DAILY_BUDGET_MINOR * 2 });
    } else {
      log("nenhum adset fonte pra duplicar — pulei escala");
    }

    log("✅ E2E criou tudo PAUSED. Iniciando revert…");
  } finally {
    for (const { label, id } of [...created].reverse()) {
      try {
        await rawClient.request({ method: "DELETE", path: id, accessToken: ref.accessToken });
        console.log(`  ↩ deletado ${label} ${id}`);
      } catch (err) {
        console.log(`  ⚠ falha ao deletar ${label} ${id}: ${String(err)}`);
      }
    }
    console.log("\n✅ revert concluído.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("E2E FALHOU:", err);
    process.exit(1);
  });
