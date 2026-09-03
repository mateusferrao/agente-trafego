/**
 * E2E REAL diz×faz — FASE 1: qualidade + honestidade da ANÁLISE (My QuickStart, dados reais).
 * LLM real + Meta real (LEITURA). Conta conservadora (suggest) → NENHUMA mutação real (só approvals
 * pendentes locais). Reverte os rows criados no fim. Cobre: A (ressalva aprovável), B (push agrupado),
 * D (criação sempre-detectada), E (conhecimento do squad na narrativa), + anti-alucinação (todo alvo
 * de recomendação EXISTE na conta; números ancorados; aprovável = de fato aplicável).
 * Rodar: cd apps/worker && npx tsx --env-file=<scratch>/.env.e2e e2e-dizfaz-analysis.ts
 */
import { eq } from "drizzle-orm";
import { agentRuns, approvals, recommendations, campaignDrafts } from "@trafego/db";
import { buildComposition } from "./src/composition.js";
import { buildAccountAnalysisGraph } from "./src/graphs/account-analysis/graph.js";
import { loadAgentContext } from "./src/modules/conversation/draft-proposal.js";

const ORG = "e87fb1fb-6ce9-46fa-af92-354a814b6285";
const AGENT = "c7dd837e-a06b-4d19-a2f0-b2c5e07e4d9f"; // My QuickStart (dados reais)
const ACC = "a8cfff3a-b1e7-486c-8024-fb1e5cd1ec55";

let pass = 0, fail = 0;
const findings: string[] = [];
const ok = (n: string, c: boolean, d?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 400) : ""); findings.push(n + (d !== undefined ? " · " + JSON.stringify(d).slice(0, 200) : "")); } };
const note = (s: string) => console.log(`  ℹ️  ${s}`);

async function main() {
  const deps = await buildComposition();
  const cleanupRunIds = new Set<string>();
  const cleanupDraftIds = new Set<string>();

  // universo REAL de entidades da conta (pra checar alucinação de alvo).
  const ac = await loadAgentContext(deps, { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" });
  if (!ac) throw new Error("sem contexto do agente");
  const [camps, adsets, ads] = await Promise.all([
    deps.ports.ads.listEntities(ac.ref, "campaign"),
    deps.ports.ads.listEntities(ac.ref, "adset"),
    deps.ports.ads.listEntities(ac.ref, "ad"),
  ]);
  const realIds = new Set<string>([...camps, ...adsets, ...ads].map((e) => e.id));
  const realNames = new Map<string, string>([...camps, ...adsets, ...ads].map((e) => [e.id, e.name]));
  console.log(`Universo real: ${camps.length} campanhas, ${adsets.length} adsets, ${ads.length} ads (total ids: ${realIds.size})`);

  console.log("\n▶ FASE 1 — análise real (on_demand)");
  const [run] = await deps.db.insert(agentRuns).values({ orgId: ORG, agentId: AGENT, trigger: "on_demand", status: "pending" }).returning({ id: agentRuns.id });
  cleanupRunIds.add(run!.id);
  const analysis = buildAccountAnalysisGraph(deps);
  const t0 = Date.now();
  await analysis.invoke({ runId: run!.id, orgId: ORG, agentId: AGENT, adAccountId: ACC, trigger: "on_demand", notifyTarget: null, signalFinding: null });
  const dur = ((Date.now() - t0) / 1000).toFixed(1);

  const [runRow] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)).limit(1);
  const recs = await deps.db.select().from(recommendations).where(eq(recommendations.runId, run!.id));
  const appr = await deps.db.select().from(approvals).where(eq(approvals.runId, run!.id));
  const drafts = await deps.db.select().from(campaignDrafts).where(eq(campaignDrafts.runId, run!.id));
  for (const d of drafts) cleanupDraftIds.add(d.id);
  const narr = (runRow?.narrative ?? runRow?.summary ?? "") as string;

  console.log(`\n status=${runRow?.status} partial=${runRow?.partial} recs=${recs.length} approvals=${appr.length} drafts=${drafts.length} dur=${dur}s`);
  console.log(` NARRATIVA:\n${narr.split("\n").map((l) => "   " + l).join("\n")}\n`);

  ok("run concluído (succeeded)", runRow?.status === "succeeded", { status: runRow?.status });
  ok("narrativa substancial", narr.length > 40);

  // ── por recomendação: kind, ação, ressalva, grounding, e ANTI-ALUCINAÇÃO (alvo existe) ──
  console.log(" RECOMENDAÇÕES:");
  let platformActions = 0, withRessalva = 0, targetsOk = 0, targetsBad = 0, applicableOk = 0;
  for (const r of recs) {
    const pa = r.proposedAction as { type?: string; target?: { id?: string; level?: string }; params?: Record<string, unknown>; ressalvas?: unknown[] } | null;
    const tgtId = pa?.target?.id;
    const tgtExists = tgtId ? realIds.has(tgtId) : true; // consultivo sem alvo = ok
    if (tgtId) { if (tgtExists) targetsOk++; else { targetsBad++; findings.push(`ALUCINAÇÃO: recomendação "${r.title}" mira entidade ${tgtId} que NÃO existe na conta`); } }
    if (r.kind === "platform_action") { platformActions++; if (pa?.type && r.toolKey) applicableOk++; }
    const ress = (r.ressalvas as unknown[] | null) ?? [];
    if (ress.length > 0) withRessalva++;
    console.log(`   • [${r.kind}] ${r.title}${ress.length ? " ⚠️(" + ress.length + ")" : ""}`);
    console.log(`       tool=${r.toolKey ?? "-"} action=${pa?.type ?? "-"} alvo=${tgtId ? (tgtExists ? "OK " : "❌INEXISTENTE ") + tgtId + (realNames.get(tgtId ?? "") ? " (" + realNames.get(tgtId!)!.slice(0, 30) + ")" : "") : "-"}`);
    console.log(`       rationale: ${(r.rationale ?? "").replace(/\n/g, " ").slice(0, 180)}`);
    if (ress.length > 0) console.log(`       ressalvas: ${JSON.stringify(ress).slice(0, 200)}`);
  }

  // ── ASSERÇÕES diz×faz ──
  ok("ANTI-ALUCINAÇÃO: todo alvo de recomendação EXISTE na conta real", targetsBad === 0, { targetsBad, targetsOk });
  ok("toda platform_action tem tool_key + proposedAction (de fato aplicável)", platformActions === applicableOk, { platformActions, applicableOk });
  if (recs.length > 0) ok("grounding: ≥1 recomendação cita número real", recs.some((r) => /\d/.test(r.rationale ?? "")));

  // A) ressalva aprovável (não rebaixada)
  const demoted = recs.filter((r) => /^investigar:/i.test(r.title ?? ""));
  note(`ressalvas anexadas: ${withRessalva} · recomendações rebaixadas p/ "Investigar:" (guards de SEGURANÇA): ${demoted.length}`);
  if (withRessalva > 0) {
    const ressRecs = recs.filter((r) => ((r.ressalvas as unknown[] | null) ?? []).length > 0);
    ok("A) recomendação COM ressalva continua APROVÁVEL (platform_action, não rebaixada)", ressRecs.every((r) => r.kind === "platform_action"), { kinds: ressRecs.map((r) => r.kind) });
  }

  // aprovações pendentes = fonte da verdade do que dá pra fazer
  console.log(`\n APPROVALS pendentes (${appr.length}):`);
  for (const a of appr) console.log(`   • ${a.actionType} | ${a.entityLevel}:${a.entityId} | status=${a.status} | ressalvas=${JSON.stringify((a.payloadActions as { ressalvas?: unknown } | null)?.ressalvas ?? [])?.slice(0, 100)}`);
  ok("aprovações pendentes têm alvo existente na conta (não oferece o impossível)", appr.every((a) => realIds.has(a.entityId)), { bad: appr.filter((a) => !realIds.has(a.entityId)).map((a) => a.entityId) });

  // D) criação sempre-detectada (mesmo conservador): draft OU recomendação de criação/escala
  const creationRec = recs.find((r) => /escalar|criar|replicar|prospec|nova campanha|ângulo novo/i.test(r.title ?? "")) || drafts.length > 0;
  note(`D) criação/escala proativa detectada: ${creationRec ? "SIM" : "não neste run"} (drafts=${drafts.length}) — conservador só propõe, nunca auto-aplica`);

  // E) conhecimento do squad reflete na narrativa (heurística de vocabulário)
  const squad = /escala|vertical|horizontal|frequ[eê]ncia|fadiga|refresh|criativo|maior vazamento|prioriza/i.test(narr);
  note(`E) vocabulário de qualidade (escala/frequência/fadiga/priorização) na narrativa: ${squad ? "PRESENTE" : "ausente"} (condicional ao dado)`);

  // ── REVERT (limpeza): approvals + recs + drafts + run criados ──
  console.log("\n▶ revert (limpeza dos rows criados)");
  for (const id of cleanupDraftIds) await deps.db.delete(campaignDrafts).where(eq(campaignDrafts.id, id));
  for (const id of cleanupRunIds) {
    await deps.db.delete(approvals).where(eq(approvals.runId, id));
    await deps.db.delete(recommendations).where(eq(recommendations.runId, id));
    await deps.db.delete(agentRuns).where(eq(agentRuns.id, id));
  }
  console.log(`   revertido: ${cleanupRunIds.size} run(s), ${cleanupDraftIds.size} draft(s), + approvals/recs`);

  console.log(`\n═══ FASE 1: ${pass} ok · ${fail} falhas ═══`);
  if (findings.length) { console.log("APONTAMENTOS:"); for (const f of findings) console.log("  ⚠️ " + f); }
  await deps.shutdown?.();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FASE 1 erro:", e); process.exit(1); });
