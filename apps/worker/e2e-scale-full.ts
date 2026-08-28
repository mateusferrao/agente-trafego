/** E2E REAL e extensivo da ESCALA de vencedor (proposeScaleWinner) — todos os caminhos + guardas,
 *  usando um adset ABO REAL da conta (readEntityState ao vivo) + winner semeado + config/bindings
 *  por caso. Não escreve na Meta (o propose só monta ação/rascunho); rascunho criado é limpo.
 *  Restaura guardrail/bindings/winner ao fim. Token do banco. */
import { and, eq } from "drizzle-orm";
import { agentToolBindings, approvals, campaignDrafts, entityAnalyses, guardrailConfigs, recommendations } from "@trafego/db";
import { buildComposition } from "./src/composition.js";
import { proposeScaleWinner } from "./src/modules/conversation/draft-proposal.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";
const ABO_ADSET = process.env["E2E_ABO_ADSET"] ?? "120249988687510295"; // legado ABO (daily > 0)
const WINNER_NAME = "E2E ABO winner";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 200) : ""); } };
const ctx = { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" };

async function main() {
  const deps = await buildComposition();
  const { db } = deps;
  const [g0] = await db.select().from(guardrailConfigs).where(eq(guardrailConfigs.agentId, AGENT)).limit(1);
  const orig = { scalePct: g0!.scalePct, maxPct: g0!.maxBudgetChangePct };
  const setG = (scalePct: number, maxPct: number) => db.update(guardrailConfigs).set({ scalePct, maxBudgetChangePct: maxPct }).where(eq(guardrailConfigs.agentId, AGENT));
  const bind = (k: string, m: "enabled" | "disabled") => db.insert(agentToolBindings).values({ orgId: ORG, agentId: AGENT, toolKey: k, mode: m } as never).onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode: m } });
  const clearBinds = () => db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "adjust_budget"))).then(() => db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "duplicate_scale"))));
  const cleanupDrafts = async () => {
    const rows = await db.select({ id: campaignDrafts.id }).from(campaignDrafts).where(and(eq(campaignDrafts.agentId, AGENT), eq(campaignDrafts.kind, "duplicate")));
    for (const r of rows) { await db.delete(approvals).where(eq(approvals.draftId, r.id)); await db.delete(recommendations).where(eq(recommendations.draftId, r.id)); await db.delete(campaignDrafts).where(eq(campaignDrafts.id, r.id)); }
  };

  try {
    // ── F) SEM vencedor → bloqueia (antes de semear) ──
    console.log("\n▶ F) sem vencedor na última análise → bloqueia");
    await bind("adjust_budget", "enabled");
    const noWin = await proposeScaleWinner(deps, ctx);
    ok("bloqueia sem vencedor", noWin.kind === "blocked" && /vencedor/i.test((noWin as { reason?: string }).reason ?? ""), noWin);

    // semeia o winner = adset ABO real.
    await db.insert(entityAnalyses).values({ agentId: AGENT, entityId: ABO_ADSET, entityLevel: "adset", entityName: WINNER_NAME, tier: "winner", runId: null, unitJson: {}, metricsJson: {}, flags: [] } as never);

    // ── A) ABO adset daily, passo pequeno (scale<=maxPct) → raise no ADSET (daily) ──
    console.log("▶ A) ABO adset daily, passo pequeno → raise no CONJUNTO");
    await setG(10, 20);
    await bind("adjust_budget", "enabled"); await bind("duplicate_scale", "enabled");
    const a = await proposeScaleWinner(deps, ctx, WINNER_NAME);
    ok("A: kind=action (raise)", a.kind === "action", a);
    if (a.kind === "action") {
      ok("A: mira o CONJUNTO (adset)", a.action.target.level === "adset" && a.action.target.id === ABO_ADSET, a.action.target);
      ok("A: pct = scale_pct (10)", a.action.params["pct"] === 10, a.action.params);
    }

    // ── B) passo agressivo (scale>maxPct), raise+dup on → PERGUNTA ──
    console.log("▶ B) passo agressivo + raise&dup on → ASK (subir vs duplicar)");
    await setG(80, 20);
    const b = await proposeScaleWinner(deps, ctx, WINNER_NAME);
    ok("B: kind=ask", b.kind === "ask", b);
    if (b.kind === "ask") ok("B: raisePct=20 (clamp) + duplicatePct=80", b.raisePct === 20 && b.duplicatePct === 80, b);

    // ── C) agressivo, só raise on → força raise clampado ──
    console.log("▶ C) agressivo, só raise on → raise clampado (20)");
    await bind("duplicate_scale", "disabled");
    const c = await proposeScaleWinner(deps, ctx, WINNER_NAME);
    ok("C: kind=action raise clampado a 20", c.kind === "action" && c.action.params["pct"] === 20, c);

    // ── D) agressivo, só duplicate on → rascunho de duplicação ──
    console.log("▶ D) agressivo, só duplicate on → rascunho de duplicação");
    await bind("adjust_budget", "disabled"); await bind("duplicate_scale", "enabled");
    const d = await proposeScaleWinner(deps, ctx, WINNER_NAME);
    ok("D: kind=draft (duplicação)", d.kind === "draft", d);
    await cleanupDrafts();

    // ── E) raise off + dup off → bloqueia ──
    console.log("▶ E) raise off + dup off → bloqueia escala");
    await bind("adjust_budget", "disabled"); await bind("duplicate_scale", "disabled");
    const e = await proposeScaleWinner(deps, ctx, WINNER_NAME);
    ok("E: bloqueado (escala desligada)", e.kind === "blocked", e);
  } finally {
    await clearBinds();
    await cleanupDrafts();
    await db.delete(entityAnalyses).where(and(eq(entityAnalyses.agentId, AGENT), eq(entityAnalyses.entityId, ABO_ADSET)));
    await db.update(guardrailConfigs).set({ scalePct: orig.scalePct, maxBudgetChangePct: orig.maxPct }).where(eq(guardrailConfigs.agentId, AGENT));
    console.log(`\n── ${pass} ok, ${fail} falha ── (config/bindings/winner restaurados)`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 4).join(" | ")); process.exit(1); });
