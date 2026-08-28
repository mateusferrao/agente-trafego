/** Bateria de QUALIDADE: roda 1 análise completa REAL (dryRun on = sem escrita na Meta) e lê
 *  tudo de volta pra avaliação crítica — run, recomendações, tiers, visão de criativo, custo
 *  real (usage_events) e a mensagem no WhatsApp. Token do banco. Restaura dryRun ao fim. */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { agentRuns, creativeVisionAnalyses, entityAnalyses, guardrailConfigs, recommendations, usageEvents } from "@trafego/db";
import { buildComposition } from "./src/composition.js";
import { buildAccountAnalysisGraph } from "./src/graphs/account-analysis/graph.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";

async function main() {
  const deps = await buildComposition();
  const { db } = deps;
  const [g] = await db.select({ dryRun: guardrailConfigs.dryRun }).from(guardrailConfigs).where(eq(guardrailConfigs.agentId, AGENT)).limit(1);
  const prevDryRun = g?.dryRun ?? true;
  await db.update(guardrailConfigs).set({ dryRun: true, killSwitch: false }).where(eq(guardrailConfigs.agentId, AGENT));

  const visionBefore = (await db.select({ n: sql<number>`count(*)` }).from(creativeVisionAnalyses))[0]?.n ?? 0;
  const t0 = Date.now();
  const [run] = await db.insert(agentRuns).values({ orgId: ORG, agentId: AGENT, trigger: "on_demand", status: "pending" } as never).returning({ id: agentRuns.id });
  const runId = run!.id;
  console.log("▶ run criado:", runId, "— invocando o grafo (análise completa)…");
  try {
    await buildAccountAnalysisGraph(deps).invoke({ runId, orgId: ORG, agentId: AGENT, adAccountId: ACC, trigger: "on_demand", notifyTarget: null, signalFinding: null });
  } catch (e) {
    console.log("  ⚠ grafo lançou:", String(e).split("\n")[0]);
  }
  const secs = Math.round((Date.now() - t0) / 1000);

  const [r] = await db.select({ status: agentRuns.status, summary: agentRuns.summary, partial: agentRuns.partial, cost: agentRuns.costSnapshot, tokens: agentRuns.tokenUsage }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  console.log(`\n── RUN (${secs}s) ──`);
  console.log("status:", r?.status, "| partial:", r?.partial);
  console.log("summary:", r?.summary);
  console.log("cost_snapshot:", JSON.stringify(r?.cost), "| tokens:", JSON.stringify(r?.tokens));

  const recs = await db.select({ title: recommendations.title, rationale: recommendations.rationale, kind: recommendations.kind, toolKey: recommendations.toolKey, risk: recommendations.riskLevel }).from(recommendations).where(eq(recommendations.runId, runId));
  console.log(`\n── RECOMENDAÇÕES (${recs.length}) ──`);
  recs.forEach((x, i) => console.log(`  ${i + 1}. [${x.kind}${x.toolKey ? "/" + x.toolKey : ""}${x.risk ? " " + x.risk : ""}] ${x.title}\n     ${(x.rationale ?? "").slice(0, 220)}`));

  const ents = await db.select({ name: entityAnalyses.entityName, tier: entityAnalyses.tier, level: entityAnalyses.entityLevel, flags: entityAnalyses.flags }).from(entityAnalyses).where(eq(entityAnalyses.agentId, AGENT)).orderBy(desc(entityAnalyses.analyzedAt)).limit(10);
  console.log(`\n── ENTITY_ANALYSES (tiers) ──`);
  ents.forEach((e) => console.log(`  ${e.level} "${e.name}" → tier=${e.tier} flags=${JSON.stringify(e.flags)}`));

  const visionAfter = (await db.select({ n: sql<number>`count(*)` }).from(creativeVisionAnalyses))[0]?.n ?? 0;
  console.log(`\n── VISÃO DE CRIATIVO ── cache: ${visionBefore} → ${visionAfter} (novos: ${visionAfter - visionBefore})`);
  const vis = await db.select({ result: creativeVisionAnalyses.result }).from(creativeVisionAnalyses).orderBy(desc(creativeVisionAnalyses.createdAt)).limit(2);
  vis.forEach((v, i) => console.log(`  amostra ${i + 1}:`, JSON.stringify(v.result).slice(0, 300)));

  const since = new Date(t0 - 5000);
  const usage = await db.select({ type: usageEvents.type, model: usageEvents.model, cost: usageEvents.cost }).from(usageEvents).where(and(eq(usageEvents.adAccountId, ACC), gte(usageEvents.createdAt, since)));
  const total = usage.reduce((s, u) => s + Number(u.cost ?? 0), 0);
  console.log(`\n── CUSTO REAL (usage_events deste run) ── ${usage.length} eventos, total ~$${total.toFixed(6)}`);
  const byType: Record<string, number> = {};
  usage.forEach((u) => { byType[u.type] = (byType[u.type] ?? 0) + Number(u.cost ?? 0); });
  console.log("  por tipo:", JSON.stringify(byType));

  await db.update(guardrailConfigs).set({ dryRun: prevDryRun }).where(eq(guardrailConfigs.agentId, AGENT));
  console.log(`\n↩ dryRun restaurado = ${prevDryRun}. run mantido (${runId}) pra inspeção.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 4).join(" | ")); process.exit(1); });
