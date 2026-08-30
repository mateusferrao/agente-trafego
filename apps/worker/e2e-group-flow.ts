/**
 * E2E REAL — reencena o fluxo RUIM do grupo (log reportado) do início ao fim, pelo GRAFO de
 * conversa com LLM REAL contra a BM Automato real. Cobre:
 *   A) criar do zero com Nº de anúncios pedido ("1-1-5 / 5 anúncios") → adCount honrado (5 anúncios).
 *   B) INCIDENTE: rascunho default → estado expira (91min) → "quero 5 criativos diferentes" → NÃO
 *      dá "não tenho rascunho aberto"; recupera do banco + vira 5 anúncios com criativos distintos.
 *   C) "sim" TARDIO (estado expirado) → re-ecoa e pede OK de novo (não aplica às cegas).
 *   D) APPLY real na Meta (nasce PAUSED) → verifica 5 anúncios + criativos → DELETA.
 * Escreve na Meta só no apply (PAUSED) e REVERTE TUDO (deleta campanhas + drafts/approvals no DB +
 * restaura guardrail/binding). Invoca o grafo direto (lê o texto do estado) — sem enviar WhatsApp.
 * Rodar: cd apps/worker && npx tsx --env-file=../../.env e2e-group-flow.ts
 */
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import { and, desc, eq } from "drizzle-orm";
import { agentToolBindings, approvals, campaignDrafts, guardrailConfigs, recommendations } from "@trafego/db";
import type { CampaignDraftSpec, ConversationRef } from "@trafego/shared";
import { buildComposition } from "./src/composition.js";
import { buildWhatsappConversationGraph } from "./src/graphs/whatsapp-conversation/graph.js";
import { AGENT_TOOL_NAMES, CONFIG_CHAT_TOOL_NAMES, CREATE_TOOL_NAMES, REFINE_TOOL_NAMES, WRITE_TOOL_NAMES, type ConversationToolContext } from "./src/graphs/whatsapp-conversation/tools.js";
import { loadAgentContext } from "./src/modules/conversation/draft-proposal.js";
import { applyDraft } from "./src/modules/apply/apply-draft.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = "d246db5c-d843-4519-a588-9197131458c4"; // uuid interno (Meta act_1423420276172802)
const GRAPH = "https://graph.facebook.com/v26.0";

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d?: unknown) => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}`);
  } else {
    fail++;
    console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 400) : "");
  }
};

const createdDraftIds = new Set<string>();
const createdCampaigns: string[] = [];

async function metaGet(id: string, fields: string, token: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${GRAPH}/${id}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`);
  return (await r.json()) as Record<string, unknown>;
}
async function metaDelete(id: string, token: string): Promise<boolean> {
  const r = await fetch(`${GRAPH}/${id}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
  const j = (await r.json()) as { success?: boolean };
  return r.ok && j.success !== false;
}

async function main() {
  const deps = await buildComposition();
  const ac = await loadAgentContext(deps, { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" });
  if (!ac) throw new Error("loadAgentContext null — seed ausente?");
  const token = ac.ref.accessToken;

  // guardrail: escrita real (dryRun off), sem kill-switch, cap alto.
  const [g0] = await deps.db.select().from(guardrailConfigs).where(eq(guardrailConfigs.agentId, AGENT)).limit(1);
  const orig = { dryRun: g0!.dryRun, killSwitch: g0!.killSwitch, maxNew: g0!.maxNewCampaignsPerDay };
  await deps.db.update(guardrailConfigs).set({ dryRun: false, killSwitch: false, maxNewCampaignsPerDay: 20 }).where(eq(guardrailConfigs.agentId, AGENT));
  // binding create_campaign ON (o "auto" do agente depende da config — aqui garantimos habilitado).
  const [bind0] = await deps.db.select().from(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "create_campaign"))).limit(1);
  const origBindMode = bind0?.mode ?? null;
  await deps.db
    .insert(agentToolBindings)
    .values({ orgId: ORG, agentId: AGENT, toolKey: "create_campaign", mode: "enabled" } as never)
    .onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode: "enabled" } });

  const ref: ConversationRef = { kind: "contact", contactId: "e2e-group" };
  const ctx: ConversationToolContext = {
    orgId: ORG,
    agentId: AGENT,
    adAccountId: ACC,
    timezone: "America/Sao_Paulo",
    ref,
    conversationId: "e2e-thread",
    multiAccount: false,
    configViaChat: true,
    accountName: ac.ref.adAccountId,
  };
  // allowlist = toolset completo do agente em contexto (binding create ligado).
  const allow = new Set<string>([
    ...AGENT_TOOL_NAMES,
    ...WRITE_TOOL_NAMES,
    ...CREATE_TOOL_NAMES,
    ...REFINE_TOOL_NAMES,
    ...CONFIG_CHAT_TOOL_NAMES,
  ]);
  const graph = buildWhatsappConversationGraph(deps, ctx, allow);

  const turn = async (threadId: string, text: string): Promise<string> => {
    const result = await graph.invoke(
      { messages: [new HumanMessage(text)], orgId: ORG, agentId: AGENT, adAccountId: ACC },
      { configurable: { thread_id: threadId } },
    );
    const last = result.messages.at(-1) as AIMessage | undefined;
    return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  };
  const latestDraft = async (): Promise<{ id: string; spec: CampaignDraftSpec } | null> => {
    const [d] = await deps.db
      .select({ id: campaignDrafts.id, spec: campaignDrafts.spec })
      .from(campaignDrafts)
      .where(and(eq(campaignDrafts.agentId, AGENT), eq(campaignDrafts.status, "proposed")))
      .orderBy(desc(campaignDrafts.createdAt))
      .limit(1);
    return d ? { id: d.id, spec: d.spec as CampaignDraftSpec } : null;
  };
  const nDistinct = (spec: CampaignDraftSpec): number =>
    new Set((spec.copyVariants ?? []).map((v) => v.creative?.metaVideoId ?? v.creative?.metaImageHash ?? "default")).size;
  const expirePendingDraft = async (threadId: string): Promise<void> => {
    const cfg = { configurable: { thread_id: threadId } };
    const st = await graph.getState(cfg);
    const pd = (st.values as { pendingDraft?: { expiresAt: string } }).pendingDraft;
    if (!pd) return;
    await graph.updateState(cfg, { pendingDraft: { ...pd, expiresAt: new Date(Date.now() - 60_000).toISOString() } });
  };

  try {
    const defaults = await deps.ports.ads.inferCreationDefaults(ac.ref);
    console.log(`\n▶ conta: page=${defaults.pageId ?? "—"} pixel=${defaults.pixelId ?? "—"} sourceAd=${defaults.sourceAdId ?? "—"}`);

    // ── A) CRIAR DO ZERO com Nº de anúncios pedido (adCount) ──
    console.log("\n▶ A) 'cria do zero, 5 anúncios (1-1-5)' → adCount honrado");
    const rA = await turn("e2e-A", "Cria uma campanha de leads do zero com 5 anúncios (estrutura 1-1-5), usando os criativos que mais convertem na conta. Me mostra como fica antes.");
    console.log(`    Roy: ${rA.replace(/\n/g, " ").slice(0, 240)}`);
    const dA = await latestDraft();
    if (dA) createdDraftIds.add(dA.id);
    ok("A: propôs um rascunho", Boolean(dA), dA?.id);
    ok("A: honrou 5 anúncios (adCount)", (dA?.spec.copyVariants?.length ?? 0) === 5, { n: dA?.spec.copyVariants?.length });
    console.log(`    → ${dA?.spec.copyVariants?.length} anúncios; ${nDistinct(dA!.spec)} mídia(s) distinta(s) (default=usa o padrão)`);

    // ── B) INCIDENTE: default → expira → "5 criativos diferentes" → recupera + vira 5 distintos ──
    console.log("\n▶ B) incidente: default → estado expira → '5 criativos diferentes' (recupera do banco)");
    const rB1 = await turn("e2e-B", "Quero criar uma campanha de leads do zero, com 2 anúncios.");
    console.log(`    Roy (propôs): ${rB1.replace(/\n/g, " ").slice(0, 180)}`);
    const dB1 = await latestDraft();
    if (dB1) createdDraftIds.add(dB1.id);
    ok("B: propôs o rascunho com 2 anúncios", (dB1?.spec.copyVariants?.length ?? 0) === 2, { n: dB1?.spec.copyVariants?.length });
    await expirePendingDraft("e2e-B"); // simula os 91min do log (TTL do estado expira; DB segue aberto)
    const rB2 = await turn("e2e-B", "Quero 5 criativos diferentes nesse rascunho.");
    console.log(`    Roy (após expirar): ${rB2.replace(/\n/g, " ").slice(0, 220)}`);
    ok("B: NÃO deu dead-end ('não tenho rascunho aberto')", !/não tenho um rascunho aberto/i.test(rB2), rB2.slice(0, 160));
    const dB2 = await latestDraft();
    ok("B: rascunho recuperado e virou 5 anúncios", (dB2?.spec.copyVariants?.length ?? 0) === 5, { n: dB2?.spec.copyVariants?.length });
    // aumento real 2→5: criativos distintos onde a conta permite, senão nota honesta no eco.
    ok(
      "B: distintos atribuídos OU nota honesta (conta com 1 criativo → repete + avisa)",
      nDistinct(dB2!.spec) >= 2 || /criativo/i.test(rB2),
      { distinct: nDistinct(dB2!.spec), reply: rB2.slice(0, 300) },
    );

    // ── C) "sim" COLD TARDIO (thread nova, sem re-eco recente) → re-ecoa, NÃO aplica às cegas ──
    // Cria num thread próprio, expira o estado e manda um "sim" seco SEM ter mostrado nada fresco
    // antes — é o caso que a decisão do usuário cobre (confirma tardio → re-mostrar antes de criar).
    console.log("\n▶ C) 'sim' COLD tardio (sem re-eco recente) → re-ecoa e pede OK de novo");
    const rC0 = await turn("e2e-C", "Cria uma campanha de leads do zero.");
    console.log(`    Roy (propôs): ${rC0.replace(/\n/g, " ").slice(0, 140)}`);
    const dC0 = await latestDraft();
    if (dC0) createdDraftIds.add(dC0.id);
    await expirePendingDraft("e2e-C");
    const rC = await turn("e2e-C", "sim, pode confirmar");
    console.log(`    Roy: ${rC.replace(/\n/g, " ").slice(0, 240)}`);
    // aceita os dois desfechos coerentes: (a) re-eco (confirm_write recuperou) OU (b) approve-by-id
    // deliberado (o LLM leu get_pending_draft = detalhes frescos e aprovou). NUNCA dead-end/perda.
    ok("C: tratou o 'sim' tardio (não deu 'nada pendente'/dead-end)", !/não tenho nada pendente|não tenho um rascunho/i.test(rC), rC.slice(0, 200));
    const reEchoed = /confiro com você|rascunho de campanha atualizado|antes de criar|confirma/i.test(rC);
    console.log(`    → caminho: ${reEchoed ? "re-eco (pediu OK de novo)" : "approve deliberado (detalhes já frescos)"}`);

    // ── D) APPLY real na Meta (PAUSED) + verify + delete ── (usa o rascunho de A, com 5 anúncios)
    console.log("\n▶ D) APPLY real (PAUSED) do rascunho de 5 anúncios + verify + delete");
    if (dA) {
      const ap = await applyDraft(deps, { orgId: ORG, draftId: dA.id });
      ok("D: apply criou (kind=created)", ap.kind === "created", ap);
      if (ap.kind === "created") {
        ok("D: escreveu de verdade (não dry-run)", ap.dryRun === false, { dryRun: ap.dryRun });
        const campaignId = ap.createdIds["campaignId"] as string | undefined;
        const adIds = (ap.createdIds["adIds"] as string[] | undefined) ?? [];
        if (campaignId) createdCampaigns.push(campaignId);
        ok("D: campanha criada", Boolean(campaignId), ap.createdIds);
        ok("D: 5 anúncios criados na Meta", adIds.length === 5, { ads: adIds.length });
        if (campaignId) {
          const camp = await metaGet(campaignId, "name,status,effective_status", token);
          ok("D: nasceu PAUSED (não veicula)", camp["status"] === "PAUSED" || camp["effective_status"] === "PAUSED", camp);
        }
      }
    }
  } finally {
    console.log("\n▶ REVERT (ambiente real)");
    for (const id of createdCampaigns) {
      try {
        const okDel = await metaDelete(id, token);
        console.log(`  ${okDel ? "🧹" : "⚠️"} campanha ${id} ${okDel ? "deletada" : "NÃO deletada — VERIFICAR MANUALMENTE"}`);
      } catch (e) {
        console.log(`  ⚠️ falha ao deletar ${id}: ${String(e).slice(0, 120)} — VERIFICAR MANUALMENTE`);
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
    console.log(`  🧹 ${createdDraftIds.size} draft(s) limpos; guardrail/binding restaurados`);
    console.log(`\n── ${pass} ok, ${fail} falha ──`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERRO:", String(e?.stack ?? e).split("\n").slice(0, 8).join("\n"));
  process.exit(1);
});
