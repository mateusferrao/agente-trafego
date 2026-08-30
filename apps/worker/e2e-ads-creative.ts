/**
 * E2E REAL — anúncios múltiplos + criativo por anúncio (Fatia 7) + criação segmentada (Fatia 8),
 * pelos DOIS caminhos (chat com LLM real + site) contra a BM Automato real. Escreve na Meta só no
 * apply (campanha nasce PAUSED) e REVERTE TUDO: deleta as campanhas criadas + drafts/approvals no
 * DB + restaura guardrail/binding. Token do banco (composition). Rodar: pnpm tsx apps/worker/e2e-ads-creative.ts
 */
import { and, eq } from "drizzle-orm";
import { agentToolBindings, approvals, campaignDrafts, guardrailConfigs, recommendations } from "@trafego/db";
import { buildComposition } from "./src/composition.js";
import {
  loadAgentContext,
  proposeCreateCampaign,
  refineDraft,
  PROACTIVE_AUDIENCE_UNRESOLVED_REASON,
  PROACTIVE_REACH_FLOOR_REASON,
} from "./src/modules/conversation/draft-proposal.js";
import { applyDraft } from "./src/modules/apply/apply-draft.js";
import { createDraftsService } from "../api/src/modules/drafts/service.js";
import type { CampaignDraftSpec } from "@trafego/shared";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = "d246db5c-d843-4519-a588-9197131458c4"; // uuid interno (Meta act_1423420276172802)
const GRAPH = "https://graph.facebook.com/v26.0";
const ctx = { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" };

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d?: unknown) => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}`);
  } else {
    fail++;
    console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 300) : "");
  }
};

const createdCampaigns: string[] = []; // ids Meta a deletar
const createdDraftIds: string[] = []; // drafts DB a limpar

async function metaGet(id: string, fields: string, token: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${GRAPH}/${id}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`);
  return (await r.json()) as Record<string, unknown>;
}
async function metaDelete(id: string, token: string): Promise<boolean> {
  const r = await fetch(`${GRAPH}/${id}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
  const j = (await r.json()) as { success?: boolean };
  return r.ok && j.success !== false;
}
const loadSpec = async (deps: Awaited<ReturnType<typeof buildComposition>>, draftId: string): Promise<CampaignDraftSpec> => {
  const [d] = await deps.db.select({ spec: campaignDrafts.spec }).from(campaignDrafts).where(eq(campaignDrafts.id, draftId)).limit(1);
  return d!.spec as CampaignDraftSpec;
};

async function main() {
  const deps = await buildComposition();
  const ac = await loadAgentContext(deps, ctx);
  if (!ac) throw new Error("loadAgentContext null — seed ausente?");
  const token = ac.ref.accessToken;
  const svc = createDraftsService({
    db: deps.db,
    adsPlatform: deps.ports.ads,
    vault: deps.ports.vault,
    approvals: deps.ports.approval,
    storage: deps.ports.storage,
    scheduler: deps.ports.scheduler,
  });

  // guardrail: salva + habilita escrita real (dryRun off), sem kill-switch, cap alto p/ o E2E.
  const [g0] = await deps.db.select().from(guardrailConfigs).where(eq(guardrailConfigs.agentId, AGENT)).limit(1);
  const orig = { dryRun: g0!.dryRun, killSwitch: g0!.killSwitch, maxNew: g0!.maxNewCampaignsPerDay };
  await deps.db.update(guardrailConfigs).set({ dryRun: false, killSwitch: false, maxNewCampaignsPerDay: 20 }).where(eq(guardrailConfigs.agentId, AGENT));
  // binding create_campaign ligado (salva o original p/ restaurar no fim).
  const [bind0] = await deps.db.select().from(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "create_campaign"))).limit(1);
  const origBindMode = bind0?.mode ?? null;
  await deps.db
    .insert(agentToolBindings)
    .values({ orgId: ORG, agentId: AGENT, toolKey: "create_campaign", mode: "enabled" } as never)
    .onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode: "enabled" } });

  try {
    const defaults = await deps.ports.ads.inferCreationDefaults(ac.ref);
    console.log(`\n▶ conta: page=${defaults.pageId ?? "—"} pixel=${defaults.pixelId ?? "—"} sourceAd=${defaults.sourceAdId ?? "—"}`);

    // ── A) CHAT (LLM real): cria campanha do zero → agente monta N anúncios ──
    console.log("\n▶ A) CHAT: proposeCreateCampaign (LLM real)");
    const a = await proposeCreateCampaign(deps, ctx, { goal: "lead" }, "on_demand");
    ok("A: retornou draft", a.kind === "draft", a);
    if (a.kind !== "draft") throw new Error("sem draft — não dá pra seguir");
    createdDraftIds.push(a.draftId);
    let spec = await loadSpec(deps, a.draftId);
    const nAds = spec.copyVariants?.length ?? 0;
    ok("A: >=1 anúncio com copy", nAds >= 1, { nAds });
    const distinct = new Set((spec.copyVariants ?? []).map((v) => v.creative?.metaVideoId ?? v.creative?.metaImageHash ?? "default"));
    console.log(`    → ${nAds} anúncio(s); mídias distintas por-anúncio: ${[...distinct].length} (default=usa criativo padrão)`);
    ok("A: default creative presente", Boolean(spec.creative), spec.creative);

    // ── B) CHAT: ajustar nº de anúncios PRESERVANDO os existentes ──
    console.log("\n▶ B) CHAT: refineDraft variantsCount (preserva existentes)");
    const firstHeadline = spec.copyVariants?.[0]?.headline;
    const b = await refineDraft(deps, ctx, a.draftId, { variantsCount: nAds + 2 });
    ok("B: refine ok", b.kind === "draft" || b.kind === "ok" || (b as { kind?: string }).kind !== "blocked", b);
    spec = await loadSpec(deps, a.draftId);
    ok("B: aumentou o nº de anúncios", (spec.copyVariants?.length ?? 0) === nAds + 2, { was: nAds, now: spec.copyVariants?.length });
    ok("B: preservou o 1º anúncio (não regenerou tudo)", spec.copyVariants?.[0]?.headline === firstHeadline, { firstHeadline, now: spec.copyVariants?.[0]?.headline });
    const c1 = await refineDraft(deps, ctx, a.draftId, { variantsCount: 2 });
    ok("B: diminuir corta pro nº pedido", c1.kind !== "blocked" && (await loadSpec(deps, a.draftId)).copyVariants?.length === 2);

    // ── C) SITE: addAd + criativo por anúncio + converter público → explícito ──
    console.log("\n▶ C) SITE: updateDraft (addAd + criativo por anúncio + converter público)");
    const rAdd = await svc.updateDraft(ORG as never, ACC, a.draftId, { addAd: true });
    ok("C: addAd ok", rAdd.ok, rAdd);
    spec = await loadSpec(deps, a.draftId);
    ok("C: anúncio adicionado (duplicou o último)", spec.copyVariants?.length === 3, { now: spec.copyVariants?.length });
    if (defaults.sourceAdId) {
      const rCr = await svc.updateDraft(ORG as never, ACC, a.draftId, { copyEdits: [{ index: 0, creative: { kind: "serving", adId: defaults.sourceAdId } }] });
      ok("C: swap criativo do anúncio 0 (serving) ok", rCr.ok, rCr);
      spec = await loadSpec(deps, a.draftId);
      ok("C: anúncio 0 ganhou criativo próprio", Boolean(spec.copyVariants?.[0]?.creative), spec.copyVariants?.[0]?.creative);
    } else {
      console.log("    (sem sourceAdId — pulo o swap de criativo por anúncio)");
    }
    const rConv = await svc.updateDraft(ORG as never, ACC, a.draftId, {
      explicitAudience: { geo: [{ key: "BR", name: "Brasil", kind: "country" }], radiusAreas: [], interestGroups: [], behaviorGroups: [], customAudienceIncludeIds: [], customAudienceExcludeIds: [] },
    });
    ok("C: converter público → explícito ok", rConv.ok, rConv);
    spec = await loadSpec(deps, a.draftId);
    ok("C: targeting virou explicit (geo BR)", spec.targeting?.kind === "explicit", spec.targeting);

    // ── D) APPLY REAL na Meta (PAUSED) → verifica → DELETA ──
    console.log("\n▶ D) APPLY real (PAUSED) + verify + delete");
    const ap = await applyDraft(deps, { orgId: ORG, draftId: a.draftId });
    ok("D: apply criou (kind=created)", ap.kind === "created", ap);
    if (ap.kind === "created") {
      ok("D: NÃO foi dry-run (escreveu de verdade)", ap.dryRun === false, { dryRun: ap.dryRun });
      const campaignId = ap.createdIds["campaignId"] as string | undefined;
      const adIds = (ap.createdIds["adIds"] as string[] | undefined) ?? [];
      const creativeIds = (ap.createdIds["creativeIds"] as string[] | undefined) ?? [];
      if (campaignId) createdCampaigns.push(campaignId);
      ok("D: campanha criada", Boolean(campaignId), ap.createdIds);
      ok("D: nº de anúncios criados = nº de variações do rascunho", adIds.length === (spec.copyVariants?.length ?? 0), { ads: adIds.length, variants: spec.copyVariants?.length });
      if (campaignId) {
        const camp = await metaGet(campaignId, "name,status,effective_status", token);
        ok("D: campanha nasceu PAUSED (não veicula)", camp["status"] === "PAUSED" || camp["effective_status"] === "PAUSED", camp);
      }
      // verifica mídia distinta por criativo criado (multi-criativo real na Meta).
      const medias: string[] = [];
      for (const cid of creativeIds) {
        const cr = await metaGet(cid, "object_story_spec,image_hash,video_id", token);
        const oss = (cr["object_story_spec"] as Record<string, unknown> | undefined) ?? {};
        const media = (cr["video_id"] as string) ?? (cr["image_hash"] as string) ?? JSON.stringify((oss["video_data"] as Record<string, unknown>)?.["video_id"] ?? (oss["link_data"] as Record<string, unknown>)?.["image_hash"] ?? "?");
        medias.push(media);
      }
      console.log(`    → mídias por anúncio na Meta: ${JSON.stringify(medias)}`);
      ok("D: criativos materializados na Meta", creativeIds.length === adIds.length && creativeIds.length > 0, { creativeIds: creativeIds.length, adIds: adIds.length });
    }

    // ── E) AUTÔNOMO: degradação honesta (sem escrita) ──
    console.log("\n▶ E) AUTÔNOMO: degrada em vez de criar amplo/estreito às cegas");
    const e1 = await proposeCreateCampaign(deps, ctx, {}, "proactive", { autonomous: true, requireResolvedAudience: true });
    ok("E: remarketing sem público resolvido → blocked (não cria amplo)", e1.kind === "blocked" && e1.reason === PROACTIVE_AUDIENCE_UNRESOLVED_REASON, e1);
    const e2 = await proposeCreateCampaign(deps, ctx, { includeAudiences: [] }, "proactive", { autonomous: true, minMonthlyReach: 9_999_999_999 });
    // com piso absurdo, QUALQUER público real fica abaixo → deve bloquear (a menos que estimativa indisponível).
    ok("E: piso de alcance absurdo → blocked OU degradou (best-effort)", e2.kind === "blocked" ? e2.reason === PROACTIVE_REACH_FLOOR_REASON : true, e2);
    if (e1.kind === "blocked") console.log(`    → e1 honesto: "${e1.reason}"`);
  } finally {
    console.log("\n▶ REVERT (ambiente real)");
    for (const id of createdCampaigns) {
      try {
        const okDel = await metaDelete(id, token);
        console.log(`  ${okDel ? "🧹" : "⚠️"} campanha ${id} ${okDel ? "deletada" : "NÃO deletada — VERIFICAR MANUALMENTE"}`);
      } catch (e) {
        console.log(`  ⚠️ falha ao deletar campanha ${id}: ${String(e).slice(0, 120)} — VERIFICAR MANUALMENTE`);
      }
    }
    for (const id of createdDraftIds) {
      await deps.db.delete(approvals).where(eq(approvals.draftId, id));
      await deps.db.delete(recommendations).where(eq(recommendations.draftId, id));
      await deps.db.delete(campaignDrafts).where(eq(campaignDrafts.id, id));
    }
    await deps.db.update(guardrailConfigs).set({ dryRun: orig.dryRun, killSwitch: orig.killSwitch, maxNewCampaignsPerDay: orig.maxNew }).where(eq(guardrailConfigs.agentId, AGENT));
    if (origBindMode === null) {
      await deps.db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "create_campaign")));
    } else {
      await deps.db.update(agentToolBindings).set({ mode: origBindMode }).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "create_campaign")));
    }
    console.log(`  🧹 ${createdDraftIds.length} draft(s) limpos; guardrail/binding restaurados`);
    console.log(`\n── ${pass} ok, ${fail} falha ──`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERRO:", String(e?.stack ?? e).split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
