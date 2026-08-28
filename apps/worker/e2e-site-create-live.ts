/** SITE path ponta-a-ponta REAL: proposeCreateCampaign (on_demand) → applyDraft (Meta real,
 *  PAUSED) → revert Meta + limpa DB. Prova a cadeia propor→aprovar→aplicar do site na conta
 *  real. Token do banco (recolado). Restaura dryRun ao fim. */
import { and, eq } from "drizzle-orm";
import { approvals, campaignDrafts, guardrailConfigs, recommendations } from "@trafego/db";
import { MetaGraphClient } from "@trafego/ads-meta";
import { buildComposition } from "./src/composition.js";
import { proposeCreateCampaign } from "./src/modules/conversation/draft-proposal.js";
import { applyDraft } from "./src/modules/apply/apply-draft.js";

const ORG = process.env["E2E_ORG_ID"] ?? "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = process.env["E2E_AGENT_ID"] ?? "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = process.env["E2E_ACCOUNT_ID"] ?? "d246db5c-d843-4519-a588-9197131458c4";

async function main() {
  const deps = await buildComposition();
  const { db } = deps;
  const raw = new MetaGraphClient({});

  // dryRun=false pra escrita REAL; captura o valor pra restaurar.
  const [g] = await db.select({ dryRun: guardrailConfigs.dryRun }).from(guardrailConfigs).where(eq(guardrailConfigs.agentId, AGENT)).limit(1);
  const prevDryRun = g?.dryRun ?? true;
  await db.update(guardrailConfigs).set({ dryRun: false, killSwitch: false }).where(eq(guardrailConfigs.agentId, AGENT));

  let draftId: string | undefined;
  let createdIds: Record<string, unknown> = {};
  try {
    const proposal = await proposeCreateCampaign(deps, { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" }, {}, "on_demand");
    console.log("▶ proposta (eco do site):", proposal.kind);
    if (proposal.kind !== "draft") { console.log("  não virou rascunho:", JSON.stringify(proposal)); return; }
    console.log(proposal.echo);
    draftId = proposal.draftId;

    const outcome = await applyDraft(deps, { orgId: ORG, draftId });
    console.log("▶ apply (aprovar no site):", outcome.kind);
    if (outcome.kind === "created") {
      createdIds = outcome.createdIds;
      console.log("  createdIds:", JSON.stringify(createdIds));
      console.log("  dryRun:", outcome.dryRun, "→ escrita REAL na Meta:", !outcome.dryRun);
    } else {
      console.log("  detalhe:", JSON.stringify(outcome));
    }
  } finally {
    // revert Meta (ad → creative → adset → campaign)
    const token2 = await tokenFor(deps);
    const ids: string[] = [];
    for (const k of ["adIds", "creativeIds"]) if (Array.isArray(createdIds[k])) ids.push(...(createdIds[k] as string[]));
    for (const k of ["adsetId", "campaignId"]) if (typeof createdIds[k] === "string") ids.push(createdIds[k] as string);
    for (const id of ids) {
      try { await raw.request({ method: "DELETE", path: id, accessToken: token2 }); console.log(`  ↩ Meta deletado ${id}`); }
      catch (e) { console.log(`  ⚠ falha deletar ${id}: ${String(e).split("\n")[0]}`); }
    }
    // limpa DB (draft + approval + recommendation)
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
  const { eq } = await import("drizzle-orm");
  const [row] = await deps.db.select({ acc: adAccounts.tokenCripto, conn: platformConnections.tokenCripto })
    .from(adAccounts).leftJoin(platformConnections, eq(adAccounts.connectionId, platformConnections.id))
    .where(eq(adAccounts.id, ACC)).limit(1);
  return deps.ports.vault.decrypt((row!.conn ?? row!.acc)!);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
