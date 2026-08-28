/** E2E live da escala sob orçamento VITALÍCIO: (A) adset ABO com lifetime → sobe o vitalício do
 *  CONJUNTO; (B) campanha CBO com lifetime → sobe o vitalício da CAMPANHA. Cria PAUSED + revert. */
import { and, eq } from "drizzle-orm";
import { agentToolBindings, entityAnalyses } from "@trafego/db";
import { MetaGraphClient } from "@trafego/ads-meta";
import type { AdAccountRef } from "@trafego/shared/ports";
import { buildComposition } from "./src/composition.js";
import { createAnalysisRepo } from "./src/modules/analysis/repo.js";
import { proposeScaleWinner } from "./src/modules/conversation/draft-proposal.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";
const START = "2026-08-29T00:00:00-0300";
const END = "2026-09-05T00:00:00-0300";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 240) : ""); } };

async function main() {
  const deps = await buildComposition();
  const account = await createAnalysisRepo(deps.db).loadAccount(ORG, ACC);
  if (!account) throw new Error("conta não encontrada");
  const token = deps.ports.vault.decrypt(account.tokenCripto);
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken: token };
  const raw = new MetaGraphClient({});
  const acct = `act_${account.metaAdAccountId}`;
  const created: string[] = [];

  // adjust_budget ligado (escala vitalícia = raise).
  await deps.db.insert(agentToolBindings).values({ orgId: ORG, agentId: AGENT, toolKey: "adjust_budget", mode: "enabled" } as never).onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode: "enabled" } });

  const seedWinner = async (id: string, name: string) => {
    await deps.db.insert(entityAnalyses).values({ agentId: AGENT, entityId: id, entityLevel: "adset", entityName: name, tier: "winner", runId: null, unitJson: {}, metricsJson: {}, flags: [] } as never);
  };
  const clearWinner = async (id: string) => { await deps.db.delete(entityAnalyses).where(and(eq(entityAnalyses.agentId, AGENT), eq(entityAnalyses.entityId, id))); };

  try {
    // ── A) ABO adset com orçamento VITALÍCIO próprio ──
    console.log("\n▶ A) ABO adset com lifetime → escala sobe o vitalício do CONJUNTO");
    try {
      const c = await raw.request<{ id: string }>({ method: "POST", path: `${acct}/campaigns`, accessToken: token, params: { name: `E2E lifetime ABO ${Date.now()}`, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: "[]" } });
      created.push(c.data.id);
      const a = await raw.request<{ id: string }>({ method: "POST", path: `${acct}/adsets`, accessToken: token, params: { name: "E2E lifetime conjunto", campaign_id: c.data.id, status: "PAUSED", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", lifetime_budget: "10000", start_time: START, end_time: END, targeting: JSON.stringify({ geo_locations: { countries: ["BR"] } }) } });
      created.push(a.data.id);
      const st = await deps.ports.ads.readEntityState(ref, a.data.id);
      console.log("  adset budget: daily=", st["daily_budget"], "lifetime=", st["lifetime_budget"]);
      await seedWinner(a.data.id, "E2E lifetime conjunto");
      const prop = await proposeScaleWinner(deps, { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" }, "E2E lifetime conjunto");
      console.log("  proposta:", prop.kind, prop.kind === "action" ? `${prop.action.target.level}:${prop.action.target.id} — ${prop.action.reason}` : (prop as { reason?: string }).reason);
      ok("A: virou ação (não bloqueou)", prop.kind === "action", prop);
      if (prop.kind === "action") {
        ok("A: mira o CONJUNTO (adset)", prop.action.target.level === "adset" && prop.action.target.id === a.data.id, prop.action.target);
        ok("A: reason menciona vitalício", /vital/i.test(prop.action.reason ?? ""), prop.action.reason);
      }
      await clearWinner(a.data.id);
    } catch (e) { console.log("  ⚠ A pulado (Meta rejeitou o create):", String(e).split("\n")[0]); }

    // ── B) CBO campanha com orçamento VITALÍCIO ──
    console.log("\n▶ B) CBO campanha com lifetime → escala sobe o vitalício da CAMPANHA");
    try {
      const c = await raw.request<{ id: string }>({ method: "POST", path: `${acct}/campaigns`, accessToken: token, params: { name: `E2E lifetime CBO ${Date.now()}`, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: "[]", lifetime_budget: "12000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" } });
      created.push(c.data.id);
      const a = await raw.request<{ id: string }>({ method: "POST", path: `${acct}/adsets`, accessToken: token, params: { name: "E2E CBO lifetime conjunto", campaign_id: c.data.id, status: "PAUSED", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", start_time: START, end_time: END, targeting: JSON.stringify({ geo_locations: { countries: ["BR"] } }) } });
      created.push(a.data.id);
      const parent = await deps.ports.ads.getAdSetCampaignBudget(ref, a.data.id);
      console.log("  parent:", JSON.stringify(parent));
      ok("B: getAdSetCampaignBudget lifetime>0", (parent?.lifetimeBudgetMinor ?? 0) > 0 && (parent?.dailyBudgetMinor ?? 0) === 0, parent);
      await seedWinner(a.data.id, "E2E CBO lifetime conjunto");
      const prop = await proposeScaleWinner(deps, { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" }, "E2E CBO lifetime conjunto");
      console.log("  proposta:", prop.kind, prop.kind === "action" ? `${prop.action.target.level}:${prop.action.target.id} — ${prop.action.reason}` : (prop as { reason?: string }).reason);
      ok("B: virou ação (não bloqueou)", prop.kind === "action", prop);
      if (prop.kind === "action") {
        ok("B: mira a CAMPANHA", prop.action.target.level === "campaign" && prop.action.target.id === c.data.id, prop.action.target);
        ok("B: reason menciona vitalício + CBO/campanha", /vital/i.test(prop.action.reason ?? "") && /CBO|campanha/i.test(prop.action.reason ?? ""), prop.action.reason);
      }
      await clearWinner(a.data.id);
    } catch (e) { console.log("  ⚠ B pulado (Meta rejeitou o create):", String(e).split("\n")[0]); }
  } finally {
    await deps.db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "adjust_budget")));
    for (const id of [...created].reverse()) {
      try { await raw.request({ method: "DELETE", path: id, accessToken: token }); console.log(`  ↩ deletado ${id}`); } catch (e) { console.log(`  ⚠ falha deletar ${id}: ${String(e).split("\n")[0]}`); }
    }
    console.log(`\n── ${pass} ok, ${fail} falha ──`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 4).join(" | ")); process.exit(1); });
