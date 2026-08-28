/** Guardrails nas SUPERFÍCIES (site/WhatsApp) — NÃO-DESTRUTIVO: todo caso bloqueia/clampa/
 *  recusa ANTES de qualquer escrita na Meta. Site e WhatsApp funilam no MESMO apply-service
 *  (applyDraft) + proposeCreateCampaign; aqui exercito os dois + o gate de tool no chat.
 *  Restaura guardrail/bindings ao fim. Token do banco. */
import { and, desc, eq } from "drizzle-orm";
import { agentToolBindings, approvals, campaignDrafts, guardrailConfigs, messages, recommendations } from "@trafego/db";
import { buildComposition } from "./src/composition.js";
import { proposeCreateCampaign } from "./src/modules/conversation/draft-proposal.js";
import { applyDraft } from "./src/modules/apply/apply-draft.js";
import { runConversationTurn } from "./src/modules/conversation/turn.js";
import { createNotifyRepo } from "./src/modules/notify/repo.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";
const CONTACT = "028aa734-b068-440f-8f45-da831cebebf5";
const ctx = { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" };

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d) : ""); } };

async function lastReply(db: Awaited<ReturnType<typeof buildComposition>>["db"], conv: string): Promise<string> {
  const [m] = await db.select({ body: messages.body }).from(messages).where(and(eq(messages.conversationId, conv), eq(messages.direction, "outbound"))).orderBy(desc(messages.createdAt)).limit(1);
  return m?.body ?? "";
}

async function main() {
  const deps = await buildComposition();
  const { db } = deps;
  const [g0] = await db.select().from(guardrailConfigs).where(eq(guardrailConfigs.agentId, AGENT)).limit(1);
  const orig = { dryRun: g0!.dryRun, killSwitch: g0!.killSwitch, maxNewDailyBudgetMinor: g0!.maxNewDailyBudgetMinor, maxNewCampaignsPerDay: g0!.maxNewCampaignsPerDay };
  const cleanup: string[] = [];
  const set = (p: Partial<typeof orig>) => db.update(guardrailConfigs).set(p).where(eq(guardrailConfigs.agentId, AGENT));
  const bind = (mode: "enabled" | "disabled") => db.insert(agentToolBindings).values({ orgId: ORG, agentId: AGENT, toolKey: "create_campaign", mode }).onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode } });
  const clearBind = () => db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "create_campaign")));
  const insDup = async () => { const [r] = await db.insert(campaignDrafts).values({ orgId: ORG, adAccountId: ACC, agentId: AGENT, kind: "duplicate", status: "proposed", origin: "on_demand", spec: { version: 1, currency: "BRL", dailyBudgetMinor: 2000, activation: "paused" }, sourceRef: { level: "adset", id: "120249988687510295" }, createdIds: {} } as never).returning({ id: campaignDrafts.id }); cleanup.push(r!.id); return r!.id; };
  const delDraft = async (id: string) => { await db.delete(approvals).where(eq(approvals.draftId, id)); await db.delete(recommendations).where(eq(recommendations.draftId, id)); await db.delete(campaignDrafts).where(eq(campaignDrafts.id, id)); };

  try {
    await clearBind(); await set({ dryRun: true, killSwitch: false, maxNewDailyBudgetMinor: 100000, maxNewCampaignsPerDay: 5 });

    console.log("\n▶ C1 — clamp de gasto novo APARECE no eco (cap 500 = R$5/dia)");
    await set({ maxNewDailyBudgetMinor: 500 });
    const p1 = await proposeCreateCampaign(deps, ctx, {}, "on_demand");
    if (p1.kind === "draft") {
      cleanup.push(p1.draftId);
      const [row] = await db.select({ spec: campaignDrafts.spec }).from(campaignDrafts).where(eq(campaignDrafts.id, p1.draftId)).limit(1);
      ok("budget clampado a 500 no spec", (row?.spec as { dailyBudgetMinor?: number })?.dailyBudgetMinor === 500, row?.spec);
      ok("eco mostra R$ 5,00/dia", /R\$\s?5,00/.test(p1.echo), p1.echo.split("\n")[1]);
    } else ok("propose virou draft", false, p1);
    await set({ maxNewDailyBudgetMinor: 100000 });

    console.log("\n▶ B1 — create_campaign OFF → proposeCreateCampaign recusa (gate site+chat)");
    await bind("disabled");
    const p2 = await proposeCreateCampaign(deps, ctx, {}, "on_demand");
    ok("propose bloqueado (gate)", p2.kind === "blocked", p2);

    console.log("▶ B2 — create_campaign OFF → applyDraft barra (rede final do apply-service)");
    const [fs] = await db.insert(campaignDrafts).values({ orgId: ORG, adAccountId: ACC, agentId: AGENT, kind: "from_scratch", status: "proposed", origin: "on_demand", spec: { version: 1, currency: "BRL", dailyBudgetMinor: 3000, activation: "paused", pageId: "P", creative: { assetId: "x", format: "image", origin: "reuse", metaImageHash: "H" }, copyVariants: [{ primaryText: "t", headline: "h" }] } } as never).returning({ id: campaignDrafts.id });
    cleanup.push(fs!.id);
    const a2 = await applyDraft(deps, { orgId: ORG, draftId: fs!.id });
    ok("apply barrado pelo gate", a2.kind === "blocked" && /desligada/.test((a2 as { reason?: string }).reason ?? ""), a2);
    await clearBind();

    console.log("▶ A1 — kill-switch → applyDraft barra (sem Meta)");
    await set({ killSwitch: true });
    const a3 = await applyDraft(deps, { orgId: ORG, draftId: await insDup() });
    ok("apply barrado (kill switch)", a3.kind === "blocked" && /kill/i.test((a3 as { reason?: string }).reason ?? ""), a3);
    await set({ killSwitch: false });

    console.log("▶ D1 — cap campanhas/dia=0 → applyDraft barra");
    await set({ maxNewCampaignsPerDay: 0 });
    const a4 = await applyDraft(deps, { orgId: ORG, draftId: await insDup() });
    ok("apply barrado (cap/dia)", a4.kind === "blocked" && /limite/i.test((a4 as { reason?: string }).reason ?? ""), a4);
    await set({ maxNewCampaignsPerDay: 5 });

    console.log("▶ E1 — WhatsApp: create_campaign OFF → Roy não cria (gate no toolset)");
    await bind("disabled");
    const conv = await createNotifyRepo(db).ensureConversation(ORG, CONTACT);
    await runConversationTurn(deps, { orgId: ORG, ref: { kind: "contact", contactId: CONTACT }, conversationId: conv, text: "foca na conta BM - Automato" });
    await runConversationTurn(deps, { orgId: ORG, ref: { kind: "contact", contactId: CONTACT }, conversationId: conv, text: "cria uma campanha de leads nova agora" });
    console.log("  ↳ Roy:", (await lastReply(db, conv)).slice(0, 200));
    const [draftAfter] = await db.select({ id: campaignDrafts.id }).from(campaignDrafts).where(and(eq(campaignDrafts.orgId, ORG), eq(campaignDrafts.adAccountId, ACC), eq(campaignDrafts.status, "proposed"))).limit(1);
    ok("nenhum rascunho criado (tool fora do toolset)", !draftAfter, draftAfter);
    if (draftAfter) cleanup.push(draftAfter.id);
    await clearBind();
  } finally {
    for (const id of cleanup) { try { await delDraft(id); } catch { /* noop */ } }
    await clearBind();
    await set(orig);
    console.log(`\n── guardrails nas superfícies: ${pass} ok, ${fail} falha ──`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS FALHOU:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
