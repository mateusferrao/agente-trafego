/** E2E extensivo dos 2 pontos: (CBO) escalar vencedor adset-sob-CBO sobe o orçamento da CAMPANHA;
 *  (CONTEXTO) o pick da biblioteca escolhe pelo contexto via matcher LLM. Cria campanha CBO real
 *  PAUSED + revert; usa LLM real no matcher. Token do banco. */
import { and, eq } from "drizzle-orm";
import { agentToolBindings, entityAnalyses } from "@trafego/db";
import { MetaGraphClient } from "@trafego/ads-meta";
import type { AdAccountRef } from "@trafego/shared/ports";
import { buildComposition } from "./src/composition.js";
import { createAnalysisRepo } from "./src/modules/analysis/repo.js";
import { proposeScaleWinner } from "./src/modules/conversation/draft-proposal.js";
import { pickLibraryCreativeByContext } from "./src/modules/creative/match-library.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";
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

  // ── CONTEXTO (LLM real): matcher escolhe pelo contexto, não índice 0 fixo ──
  console.log("\n▶ CONTEXTO — matcher LLM escolhe o criativo que casa com o objetivo/negócio");
  const cands = [
    { assetId: "generico", description: "Oferta genérica de desconto, fundo colorido, sem contexto de nicho." },
    { assetId: "estetica", description: "Antes/depois de harmonização facial numa clínica de estética, prova visual do resultado." },
    { assetId: "carro", description: "Anúncio de concessionária de carros, test-drive." },
  ];
  const picked = await pickLibraryCreativeByContext(deps.ports.llm, deps.analysis.messageModel, { goal: "lead", businessContext: "Clínica de estética; foco em agendamentos de avaliação.", guidance: null }, cands);
  console.log("  escolha do LLM:", picked);
  ok("escolheu um candidato válido", cands.some((c) => c.assetId === picked));
  ok("escolheu pelo CONTEXTO (o de estética, não o genérico/carro)", picked === "estetica", picked);

  // ── CBO (Meta real): cria campanha CBO + adset (sem budget) → escala mira a campanha ──
  console.log("\n▶ CBO — cria campanha CBO PAUSED + adset (sem orçamento próprio)");
  let cboAdsetId: string | undefined;
  let cboCampaignId: string | undefined;
  try {
    const camp = await raw.request<{ id: string }>({ method: "POST", path: `${acct}/campaigns`, accessToken: token, params: { name: `E2E CBO ${Date.now()}`, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: "[]", daily_budget: "1000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" } });
    cboCampaignId = camp.data.id; created.push(cboCampaignId);
    const adset = await raw.request<{ id: string }>({ method: "POST", path: `${acct}/adsets`, accessToken: token, params: { name: "E2E CBO conjunto", campaign_id: cboCampaignId, status: "PAUSED", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: JSON.stringify({ geo_locations: { countries: ["BR"] } }) } });
    cboAdsetId = adset.data.id; created.push(cboAdsetId);
    console.log("  campanha CBO:", cboCampaignId, "adset:", cboAdsetId);
  } catch (e) {
    console.log("  ⚠ não consegui criar CBO (validação Meta):", String(e).split("\n")[0]);
  }

  if (cboAdsetId && cboCampaignId) {
    console.log("▶ CBO — getAdSetCampaignBudget resolve a campanha-mãe + seu orçamento");
    const parent = await deps.ports.ads.getAdSetCampaignBudget(ref, cboAdsetId);
    ok("resolveu a campanha-mãe do adset", parent?.campaignId === cboCampaignId, parent);
    ok("orçamento da campanha (CBO) > 0", (parent?.dailyBudgetMinor ?? 0) > 0, parent);

    console.log("▶ CBO — proposeScaleWinner (winner=adset CBO) → escala mira a CAMPANHA");
    // seed um winner apontando pro adset CBO + garante adjust_budget ligado (a escala CBO exige raise).
    await deps.db.insert(entityAnalyses).values({ agentId: AGENT, entityId: cboAdsetId, entityLevel: "adset", entityName: "E2E CBO conjunto", tier: "winner", runId: null, unitJson: {}, metricsJson: {}, flags: [] } as never);
    await deps.db.insert(agentToolBindings).values({ orgId: ORG, agentId: AGENT, toolKey: "adjust_budget", mode: "enabled" } as never).onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode: "enabled" } });
    try {
      const prop = await proposeScaleWinner(deps, { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" }, "E2E CBO conjunto");
      console.log("  proposta:", prop.kind, prop.kind === "action" ? JSON.stringify(prop.action.target) : (prop as { reason?: string }).reason);
      ok("virou ação de ajuste (não bloqueou)", prop.kind === "action", prop);
      if (prop.kind === "action") {
        ok("mira a CAMPANHA (não o adset)", prop.action.target.level === "campaign" && prop.action.target.id === cboCampaignId, prop.action.target);
        ok("é adjust_budget (raise)", prop.action.type === "adjust_budget");
        ok("reason menciona CBO/campanha (claro pro usuário)", /CBO|campanha/i.test(prop.action.reason ?? ""), prop.action.reason);
      }
    } finally {
      await deps.db.delete(entityAnalyses).where(and(eq(entityAnalyses.agentId, AGENT), eq(entityAnalyses.entityId, cboAdsetId)));
      await deps.db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "adjust_budget")));
    }
  }

  // revert Meta (adset → campanha)
  for (const id of [...created].reverse()) {
    try { await raw.request({ method: "DELETE", path: id, accessToken: token }); console.log(`  ↩ deletado ${id}`); } catch (e) { console.log(`  ⚠ falha deletar ${id}: ${String(e).split("\n")[0]}`); }
  }
  console.log(`\n── ${pass} ok, ${fail} falha ──`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 4).join(" | ")); process.exit(1); });
