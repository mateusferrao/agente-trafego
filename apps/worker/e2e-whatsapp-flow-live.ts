/** WhatsApp/LLM path ponta-a-ponta REAL: dois turnos no Grafo B (LLM decide a tool) —
 *  "cria uma campanha" (turno 1: propõe + eco via WhatsApp real) → "sim" (turno 2: confirma) —
 *  e aplica o rascunho criado pelo chat na Meta REAL (PAUSED) + revert. O apply do chat
 *  ENFILEIRA no apply-service (BullMQ); aqui aplico o MESMO applyDraft direto (equivalente,
 *  determinístico) pra fechar o loop sem depender do consumidor. Token do banco. */
import { and, desc, eq } from "drizzle-orm";
import { approvals, campaignDrafts, guardrailConfigs, messages, recommendations } from "@trafego/db";
import { MetaGraphClient } from "@trafego/ads-meta";
import { buildComposition } from "./src/composition.js";
import { createNotifyRepo } from "./src/modules/notify/repo.js";
import { runConversationTurn } from "./src/modules/conversation/turn.js";
import { applyDraft } from "./src/modules/apply/apply-draft.js";

const ORG = process.env["E2E_ORG_ID"] ?? "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = process.env["E2E_AGENT_ID"] ?? "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = process.env["E2E_ACCOUNT_ID"] ?? "d246db5c-d843-4519-a588-9197131458c4";
const CONTACT = process.env["E2E_CONTACT_ID"] ?? "028aa734-b068-440f-8f45-da831cebebf5";

async function lastOutbound(db: Awaited<ReturnType<typeof buildComposition>>["db"], conversationId: string): Promise<string> {
  const [m] = await db.select({ body: messages.body }).from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "outbound"))).orderBy(desc(messages.createdAt)).limit(1);
  return m?.body ?? "(sem resposta)";
}

async function main() {
  const deps = await buildComposition();
  const { db } = deps;
  const repo = createNotifyRepo(db);
  const raw = new MetaGraphClient({});
  const conversationId = await repo.ensureConversation(ORG, CONTACT);
  const ref = { kind: "contact", contactId: CONTACT } as const;

  const [g] = await db.select({ dryRun: guardrailConfigs.dryRun }).from(guardrailConfigs).where(eq(guardrailConfigs.agentId, AGENT)).limit(1);
  const prevDryRun = g?.dryRun ?? true;
  await db.update(guardrailConfigs).set({ dryRun: false, killSwitch: false }).where(eq(guardrailConfigs.agentId, AGENT));

  let draftId: string | undefined;
  let createdIds: Record<string, unknown> = {};
  try {
    console.log("▶ TURNO 0 (usuário): 'foca na conta BM - Automato' (org multi-conta → concierge)");
    await runConversationTurn(deps, { orgId: ORG, ref, conversationId, text: "foca na conta BM - Automato" });
    console.log("  ↳ Roy (WhatsApp):", (await lastOutbound(db, conversationId)).slice(0, 300));

    console.log("▶ TURNO 1 (usuário): 'cria uma campanha de leads reusando meu melhor criativo'");
    await runConversationTurn(deps, { orgId: ORG, ref, conversationId, text: "cria uma campanha de leads nova agora, pode reusar o criativo que já está rodando na conta. não precisa analisar antes." });
    console.log("  ↳ Roy (WhatsApp):", (await lastOutbound(db, conversationId)).slice(0, 400));

    const [draft] = await db.select({ id: campaignDrafts.id, kind: campaignDrafts.kind, status: campaignDrafts.status }).from(campaignDrafts).where(and(eq(campaignDrafts.orgId, ORG), eq(campaignDrafts.adAccountId, ACC))).orderBy(desc(campaignDrafts.createdAt)).limit(1);
    if (!draft || draft.status !== "proposed") { console.log("  ⚠ LLM NÃO criou rascunho no turno 1 — roteamento falhou?"); return; }
    draftId = draft.id;
    console.log(`  ✅ rascunho proposto pelo chat: ${draft.kind} ${draft.id}`);

    console.log("▶ TURNO 2 (usuário): 'sim, pode criar'");
    await runConversationTurn(deps, { orgId: ORG, ref, conversationId, text: "sim, pode criar" });
    console.log("  ↳ Roy (WhatsApp):", (await lastOutbound(db, conversationId)).slice(0, 400));

    console.log("▶ Aplicando o rascunho na Meta REAL (mesmo applyDraft do apply-service)…");
    const outcome = await applyDraft(deps, { orgId: ORG, draftId });
    console.log("  apply:", outcome.kind, outcome.kind === "created" ? `dryRun=${outcome.dryRun}` : JSON.stringify(outcome));
    if (outcome.kind === "created") createdIds = outcome.createdIds;
  } finally {
    const token = await tokenFor(deps);
    const ids: string[] = [];
    for (const k of ["adIds", "creativeIds"]) if (Array.isArray(createdIds[k])) ids.push(...(createdIds[k] as string[]));
    for (const k of ["adsetId", "campaignId", "copiedId"]) if (typeof createdIds[k] === "string") ids.push(createdIds[k] as string);
    for (const id of ids) { try { await raw.request({ method: "DELETE", path: id, accessToken: token }); console.log(`  ↩ Meta deletado ${id}`); } catch (e) { console.log(`  ⚠ falha ${id}: ${String(e).split("\n")[0]}`); } }
    if (draftId) {
      await db.delete(approvals).where(and(eq(approvals.draftId, draftId), eq(approvals.orgId, ORG)));
      await db.delete(recommendations).where(and(eq(recommendations.draftId, draftId), eq(recommendations.orgId, ORG)));
      await db.delete(campaignDrafts).where(and(eq(campaignDrafts.id, draftId), eq(campaignDrafts.orgId, ORG)));
      console.log("  ↩ DB limpo (draft/approval/recommendation)");
    }
    await db.update(guardrailConfigs).set({ dryRun: prevDryRun }).where(eq(guardrailConfigs.agentId, AGENT));
    console.log(`  ↩ dryRun restaurado = ${prevDryRun}`);
  }
}

async function tokenFor(deps: Awaited<ReturnType<typeof buildComposition>>): Promise<string> {
  const { adAccounts, platformConnections } = await import("@trafego/db");
  const [row] = await deps.db.select({ acc: adAccounts.tokenCripto, conn: platformConnections.tokenCripto })
    .from(adAccounts).leftJoin(platformConnections, eq(adAccounts.connectionId, platformConnections.id))
    .where(eq(adAccounts.id, ACC)).limit(1);
  return deps.ports.vault.decrypt((row!.conn ?? row!.acc)!);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
