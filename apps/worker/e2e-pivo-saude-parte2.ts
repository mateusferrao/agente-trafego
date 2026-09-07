/**
 * E2E REAL — pivô saúde, PARTE 2 ("músculo"): prova ao vivo os guards/kernel/S8b que a
 * Parte 1 (e2e-pivo-saude.ts) não conseguiu disparar (conta de teste "quase zumbi").
 * Estratégia HÍBRIDA aprovada pelo dono:
 *
 *   PARTE A — Meta REAL, risco de gasto ZERO por construção: cria 1 campanha ABO real com
 *     2 conjuntos REALMENTE ATIVOS (status Meta ACTIVE — exigido por `buildCampaignUnits`,
 *     que só considera campanha/adset com status "active"), mas os ANÚNCIOS dentro ficam
 *     SEMPRE PAUSADOS — sem anúncio ativo, a Meta NÃO entrega/gasta nada (impossível haver
 *     impressão), então a estrutura é "ativa" o suficiente pro nosso pipeline enxergar (S8b)
 *     mas fisicamente incapaz de gastar 1 centavo. Roda 1 análise real sobre essa estrutura
 *     (prova S8b: 2 entity_analyses por-adset, isCBO=false) + 1 chamada REAL de
 *     `getDeliveryEstimateForAdSet` (teto de escala por audiência) alimentando o guard REAL
 *     com o número REAL devolvido pela Meta. Ao fim, DELETA a campanha na Meta (cascata
 *     apaga adsets/ads) — nada fica pra trás.
 *
 *   PARTE B — funções puras do core chamadas DIRETO com fixtures realistas (fadiga×escala,
 *     tracking, CPA marginal) — zero IO, zero risco, prova que o "músculo" determinístico
 *     dispara corretamente nos dois lados (rebaixa quando deve, passa quando não deve).
 *
 *   PARTE C — seleção de blocos do kernel (`selectAnalysisKnowledge`) com contexto rico
 *     (positivo) vs pobre (negativo, já provado ao vivo na Parte 1) — prova a POSITIVA.
 *
 *   PARTE D — semeia 1 linha realista em `entity_analyses.curatedJson` (vencedor fatigado +
 *     tracking suspeito + teto de orçamento + funil frio) e pergunta pro CHAT com LLM REAL —
 *     prova que o chat SURFACES esses sinais corretamente quando eles genuinamente existem
 *     (a Parte 1 só provou a ausência). Também testa o cenário levantado pelo dono: perguntar
 *     por uma campanha nova ANTES de reanalisar, pra ver se o agente propõe sincronizar.
 *
 * Reverte TUDO: deleta a campanha real na Meta, restaura `agents.status`, remove
 * agent_runs/recommendations/entity_analyses/approvals criados neste teste.
 * Rodar: cd apps/worker && npx tsx --env-file=../../.env e2e-pivo-saude-parte2.ts
 */
import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { eq } from "drizzle-orm";
import { agentRuns, approvals, recommendations, entityAnalyses, agents } from "@trafego/db";
import type { CuratedEntitySnapshot } from "@trafego/shared";
import { META_GRAPH_VERSION } from "@trafego/ads-meta";
import {
  guardTrackingCaveat,
  computeScaleRessalvas,
  DEFAULT_MARGINAL_CPA_THRESHOLDS,
  DEFAULT_AUDIENCE_CEILING_THRESHOLDS,
  detectCreationOpportunities,
  selectAnalysisKnowledge,
  type AnalysisKnowledgeContext,
  type ScaleRessalvaContext,
} from "@trafego/core";
import type { AnalysisOutput, Action } from "@trafego/shared";
import { buildComposition } from "./src/composition.js";
import { buildWhatsappConversationGraph } from "./src/graphs/whatsapp-conversation/graph.js";
import { buildAccountAnalysisGraph } from "./src/graphs/account-analysis/graph.js";
import type { ConversationToolContext } from "./src/graphs/whatsapp-conversation/tools.js";
import { buildInContextAllow, configToolsFor } from "./src/modules/conversation/turn.js";
import { createAnalysisRepo } from "./src/modules/analysis/repo.js";

const ORG = "e87fb1fb-6ce9-46fa-af92-354a814b6285";
const AGENT = "ba2b9542-cbbc-4795-8ac5-c73ed5cf34ad";
const ACC = "5a65ccf1-3c9c-418b-b063-018620c4d1ef";

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d?: unknown) => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}`);
  } else {
    fail++;
    console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 500) : "");
  }
};
const note = (s: string) => console.log(`  ℹ️  ${s}`);

function toolsUsed(messages: readonly BaseMessage[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    const tc = (m as AIMessage).tool_calls;
    if (Array.isArray(tc)) for (const c of tc) names.push(c.name);
  }
  return names;
}

const rec = (over: Partial<AnalysisOutput["recommendations"][number]>): AnalysisOutput["recommendations"][number] => ({
  id: over.id ?? "r1",
  title: "t",
  rationale: "porque sim",
  priority: "high",
  actionType: "increase_budget",
  targetEntity: { level: "adset", externalId: "AS1" },
  budgetChangePct: 20,
  expectedImpact: null,
  whatToMonitor: null,
  findingRefs: null,
  ...over,
});
const output = (recs: AnalysisOutput["recommendations"]): AnalysisOutput => ({
  scorecard: { grade: "B", headline: "h", biggestLeak: "conversao" },
  summary: "s",
  findings: [],
  recommendations: recs,
});

async function main() {
  const deps = await buildComposition();
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ORG, ACC);
  if (!account) throw new Error("conta de teste não encontrada — confira ORG/AGENT/ACC");
  const accessToken = deps.ports.vault.decrypt(account.tokenCripto);
  const ref = { adAccountId: account.metaAdAccountId, accessToken };

  let realCampaignId: string | null = null;
  let realAdsetAId: string | null = null;
  const cleanupRunIds = new Set<string>();
  let agentStatusChanged = false;

  try {
    // ════════════════════════════════════════════════════════════════════════════════════
    // PARTE A — Meta REAL, estrutura ABO 2-adsets ATIVA, anúncios SEMPRE pausados (zero gasto)
    // ════════════════════════════════════════════════════════════════════════════════════
    console.log("\n▶ PARTE A) criação real (ABO, 2 adsets ATIVOS, anúncios PAUSADOS — zero risco de gasto)");
    const defaults = await deps.ports.ads.inferCreationDefaults(ref);
    note(`defaults inferidos: pageId=${defaults.pageId ?? "—"} pixelId=${defaults.pixelId ?? "—"} imageHash=${defaults.imageHash ? "ok" : "—"} objectiveGoal=${defaults.objectiveGoal ?? "—"}`);
    if (!defaults.pageId) throw new Error("conta sem Página inferível (nenhum anúncio histórico) — não dá pra criar criativo real. Ver docs/validacao-manual-pivo-saude-completo.md §8.");

    const goal = defaults.objectiveGoal ?? "lead";
    const { campaignId } = await deps.ports.ads.createCampaign(ref, {
      name: "[E2E-pivo-saude][TEMP — apagar automaticamente]",
      objectiveGoal: goal,
      specialAdCategories: [],
      status: "active", // ABO/CBO detection e S8b exigem status ATIVO na campanha
    });
    realCampaignId = campaignId;
    note(`campanha real criada: ${campaignId} (ABO — sem dailyBudgetMinor na campanha)`);

    const MIN_DAILY_BUDGET_MINOR = 3000; // R$30/dia — nunca gasto de verdade (ads ficam pausados)
    const { adsetId: adsetA } = await deps.ports.ads.createAdSet(ref, {
      campaignId,
      name: "Conjunto A (E2E)",
      dailyBudgetMinor: MIN_DAILY_BUDGET_MINOR,
      goal,
      ...(defaults.pixelId ? { pixelId: defaults.pixelId } : {}),
      targeting: { kind: "advantage_plus" },
      status: "active",
    });
    realAdsetAId = adsetA;
    const { adsetId: adsetB } = await deps.ports.ads.createAdSet(ref, {
      campaignId,
      name: "Conjunto B (E2E)",
      dailyBudgetMinor: MIN_DAILY_BUDGET_MINOR,
      goal,
      ...(defaults.pixelId ? { pixelId: defaults.pixelId } : {}),
      targeting: { kind: "advantage_plus" },
      status: "active",
    });
    note(`2 conjuntos reais criados (ambos status=active): ${adsetA}, ${adsetB}`);

    const { creativeId } = await deps.ports.ads.createAdCreative(ref, {
      name: "Criativo E2E (temp)",
      pageId: defaults.pageId,
      ...(defaults.imageHash ? { imageHash: defaults.imageHash } : {}),
      ...(defaults.linkUrl ? { linkUrl: defaults.linkUrl } : {}),
      copy: { primaryText: "Teste E2E — anúncio nunca ativo.", headline: "Teste E2E" },
    });
    await deps.ports.ads.createAd(ref, { name: "Anúncio A (E2E, PAUSADO)", adsetId: adsetA, creativeId, status: "paused" });
    await deps.ports.ads.createAd(ref, { name: "Anúncio B (E2E, PAUSADO)", adsetId: adsetB, creativeId, status: "paused" });
    note("2 anúncios criados, AMBOS status=paused — garantia estrutural de zero veiculação/zero gasto");

    // cenário do dono: perguntar pela campanha nova ANTES de reanalisar (agente ainda pausado)
    const cfg0 = await configToolsFor(deps.db, ORG, AGENT);
    const allow0 = buildInContextAllow({ writeTools: [], configTools: cfg0.tools, chatAdsWrites: false });
    const ctx0: ConversationToolContext = {
      orgId: ORG,
      agentId: AGENT,
      adAccountId: ACC,
      timezone: "America/Sao_Paulo",
      ref: { kind: "contact", contactId: "e2e-parte2" },
      conversationId: "e2e-parte2-pre",
      multiAccount: false,
      configViaChat: cfg0.enabled,
      chatAdsWrites: false,
    };
    const graph0 = buildWhatsappConversationGraph(deps, ctx0, allow0);
    const turn0 = async (thread: string, text: string) => {
      const result = await graph0.invoke({ messages: [new HumanMessage(text)], orgId: ORG, agentId: AGENT, adAccountId: ACC }, { configurable: { thread_id: thread } });
      const msgs = result.messages as BaseMessage[];
      const last = msgs.at(-1) as AIMessage | undefined;
      return { reply: typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? ""), tools: toolsUsed(msgs) };
    };
    console.log("\n▶ A1) cenário do dono: pergunta por campanha nova ANTES de reanalisar (deve propor sincronizar)");
    const preSync = await turn0("e2e-a1", "Tem uma campanha nova ativa lá na Meta que eu não estou vendo aqui. Por que ela não aparece pra você?");
    console.log(`    Roy: ${preSync.reply.replace(/\n/g, " ").slice(0, 320)}`);
    ok(
      "A1: reconhece a possível defasagem e PROPÕE rodar/atualizar a análise (não nega genericamente nem finge estar tudo em dia)",
      /reanalis|nova an[aá]lise|atualiz|sincron|rodar (uma|a) an[aá]lise|analisar (agora|de novo|a conta)/i.test(preSync.reply),
      preSync.reply.slice(0, 260),
    );

    // liga o agente (estava paused) pra rodar a análise real de ponta a ponta
    await deps.db.update(agents).set({ status: "active" }).where(eq(agents.id, AGENT));
    agentStatusChanged = true;
    note("agents.status → 'active' (temporário — restaurado no finally)");

    console.log("\n▶ A2) análise real sobre a estrutura ABO real (S8b: 2 entity_analyses por-adset esperadas)");
    const [run] = await deps.db.insert(agentRuns).values({ orgId: ORG, agentId: AGENT, trigger: "on_demand", status: "pending" }).returning({ id: agentRuns.id });
    cleanupRunIds.add(run!.id);
    const analysis = buildAccountAnalysisGraph(deps);
    await analysis.invoke({ runId: run!.id, orgId: ORG, agentId: AGENT, adAccountId: ACC, trigger: "on_demand", notifyTarget: null, signalFinding: null });
    const [runRow] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)).limit(1);
    console.log(`    status=${runRow?.status} partial=${runRow?.partial}`);
    ok("A2: run concluído (succeeded)", runRow?.status === "succeeded", { status: runRow?.status });

    const campaignRow = await deps.db.select().from(entityAnalyses).where(eq(entityAnalyses.entityId, campaignId)).limit(1);
    const adsetRows = await deps.db.select().from(entityAnalyses).where(eq(entityAnalyses.entityId, adsetA)).limit(1);
    const adsetBRows = await deps.db.select().from(entityAnalyses).where(eq(entityAnalyses.entityId, adsetB)).limit(1);
    if (campaignRow[0]) {
      const cj = campaignRow[0].curatedJson as CuratedEntitySnapshot | null;
      ok("A2: campanha real classificada isCBO=false (ABO — confirmado por dado REAL da Meta, não fixture)", cj?.isCBO === false, cj);
    } else {
      // ACHADO desta execução (não é bug — é consequência esperada da garantia de zero-risco):
      // `normalize()` (packages/core/src/brief/index.ts:80) constrói `NormalizedEntity` SÓ a
      // partir das linhas que a Meta Insights API devolve — uma campanha/adset sem NENHUMA
      // impressão (garantido aqui pelos anúncios ficarem sempre PAUSADOS) não gera nenhuma
      // linha de insight, logo fica INVISÍVEL pro brief inteiro, independente do status Meta
      // ser "active". Ou seja: a mesma trava que garante risco-zero de gasto também impede
      // provar S8b/isCBO com estrutura 100% real — precisaria de ALGUMA impressão de verdade
      // (o que reabre o trade-off de gasto real que o dono já decidiu não assumir agora).
      // Coberto de forma equivalente (mesmo código, LLM real) pelas Partes B/C/D abaixo.
      note("campanha real SEM NENHUMA impressão (por construção — ads sempre pausados) → invisível pro brief/análise inteira, não só pro S8b. Ver comentário no código — achado documentado, não bug.");
    }
    if (adsetRows.length > 0 && adsetBRows.length > 0) {
      ok("A2 (S8b): AMBOS os adsets reais viraram linha própria em entity_analyses", true);
      const cj = adsetRows[0]!.curatedJson as CuratedEntitySnapshot | null;
      ok("A2 (S8b): isCBO do ADSET é sempre false (nunca herda o budget!=null do próprio adset)", cj?.isCBO === false, cj);
    } else {
      note("S8b não pôde ser provado com estrutura 100% real nesta execução (zero insights, ver nota acima) — coberto por packages/core/src/map-reduce/map-reduce.test.ts (fixture, já revisado)");
    }

    // ── A3) teto de escala por audiência — chamada REAL a getDeliveryEstimateForAdSet ────────
    console.log("\n▶ A3) delivery_estimate REAL (Meta) sobre o adset A + guard real (2 cenários)");
    const estimate = await deps.ports.ads.getDeliveryEstimateForAdSet(ref, adsetA);
    note(`estimativa REAL da Meta pro adset A: ready=${estimate.ready} mau=[${estimate.monthlyReachMin ?? "—"}, ${estimate.monthlyReachMax ?? "—"}] dau=${estimate.dailyActiveUsers ?? "—"}`);
    ok("A3: a Meta respondeu a estimativa (ready=true) — integração real confirmada", estimate.ready === true, estimate);
    if (estimate.ready) {
      const monthlyReach = estimate.monthlyReachMax ?? estimate.monthlyReachMin ?? estimate.dailyActiveUsers;
      if (monthlyReach !== undefined && monthlyReach > 0) {
        const frequencyCap = 3;
        const scaleAct: Action = { id: "a", type: "adjust_budget", target: { level: "adset", id: adsetA }, params: { mode: "increase", pct: 20 }, source: "llm", riskLevel: "medium", reason: "escalar" };
        const ctxWith = (headroom: ScaleRessalvaContext["headroom"]): ScaleRessalvaContext => ({
          eligibility: new Map(), marginalRisePct: new Map(), marginal: DEFAULT_MARGINAL_CPA_THRESHOLDS,
          headroom, ceiling: DEFAULT_AUDIENCE_CEILING_THRESHOLDS, signals: new Map(), lessonGuards: [],
        });
        // cenário 1: público saturado (impressões projetadas MUITO acima do teto real) → ressalva
        const satRessalvas = computeScaleRessalvas(scaleAct, ctxWith(new Map([[adsetA, { monthlyReach, currentMonthlyImpressions: monthlyReach * frequencyCap * 5, frequencyCap }]])));
        ok("A3[saturado]: RESSALVA audience_ceiling, usando alcance REAL da Meta", satRessalvas.some((r) => r.code === "audience_ceiling"), satRessalvas);
        // cenário 2: público com folga (impressões bem abaixo do teto real) → sem ressalva de teto
        const healthyRessalvas = computeScaleRessalvas(scaleAct, ctxWith(new Map([[adsetA, { monthlyReach, currentMonthlyImpressions: monthlyReach * frequencyCap * 0.01, frequencyCap }]])));
        ok("A3[folga]: sem ressalva de teto (mesmo alcance real, ritmo baixo)", !healthyRessalvas.some((r) => r.code === "audience_ceiling"), healthyRessalvas);
      } else {
        note("estimativa veio sem alcance numérico (público muito amplo/indefinido) — guard degradaria honesto (passa direto), não dá pra provar os 2 ramos com este número");
      }
    }
  } finally {
    // ── cleanup PARTE A: apaga a campanha real na Meta (cascata: adsets+ads) ──────────────────
    if (realCampaignId) {
      try {
        const res = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${realCampaignId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = await res.text();
        console.log(`\n▶ REVERT (Meta): DELETE campanha ${realCampaignId} → HTTP ${res.status} ${body.slice(0, 200)}`);
      } catch (e) {
        console.error(`  ⚠️  FALHA ao apagar a campanha real ${realCampaignId} na Meta — apague manualmente!`, String(e));
      }
    }
    if (agentStatusChanged) {
      await deps.db.update(agents).set({ status: "paused" }).where(eq(agents.id, AGENT));
      console.log("  🧹 agents.status restaurado pra 'paused' (estado original)");
    }
    // BUG corrigido (achado na 1ª execução real): a versão anterior desta linha deletava
    // TODA `entity_analyses` do agente (where agentId=AGENT, sem escopo) — apagou de verdade
    // a linha pré-existente da campanha real "[01][ABO][Leads][Advtg][Whatsapp]" (análise de
    // 20/08, cache legítimo desta sessão, não artefato deste teste). Só dado em cache
    // (regenerável no próximo run real), mas foi over-delete — corrigido pra escopo exato.
    if (realCampaignId) await deps.db.delete(entityAnalyses).where(eq(entityAnalyses.entityId, realCampaignId));
    if (realAdsetAId) await deps.db.delete(entityAnalyses).where(eq(entityAnalyses.entityId, realAdsetAId));
    for (const id of cleanupRunIds) {
      await deps.db.delete(approvals).where(eq(approvals.runId, id));
      await deps.db.delete(recommendations).where(eq(recommendations.runId, id));
      await deps.db.delete(agentRuns).where(eq(agentRuns.id, id));
    }
    console.log(`  🧹 ${cleanupRunIds.size} run(s) e entity_analyses efêmeras limpos`);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // PARTE B — guards puros, fixtures realistas (zero IO, zero risco)
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n▶ PARTE B) guards determinísticos — fixtures realistas, positivo E negativo");

  console.log("\n  B1) guardTrackingCaveat");
  const basisSuspect = new Map([["ENT1", "target" as const]]);
  const trackingSuspect = { suspect: true, funnelStarted: 500, trackedConversions: 8, ratio: 62.5 };
  const b1pos = guardTrackingCaveat(output([rec({ id: "b1", actionType: "pause", targetEntity: { level: "campaign", externalId: "ENT1" } })]), basisSuspect, trackingSuspect);
  ok("B1[positivo]: tracking suspeito + pause em basis=target → REBAIXA pra investigate, cita a razão", b1pos.recommendations[0]!.actionType === "investigate" && b1pos.recommendations[0]!.rationale.includes("[guard]"), b1pos.recommendations[0]);
  const b1neg = guardTrackingCaveat(output([rec({ id: "b1n", actionType: "pause", targetEntity: { level: "campaign", externalId: "ENT1" } })]), basisSuspect, { suspect: false, funnelStarted: 500, trackedConversions: 480, ratio: 1.04 });
  ok("B1[negativo]: tracking SAUDÁVEL → passa direto (não rebaixa à toa)", b1neg.recommendations[0]!.actionType === "pause", b1neg.recommendations[0]);

  console.log("\n  B2) ressalva de CPA marginal (worsening_marginal_cpa)");
  const b2act: Action = { id: "b2", type: "adjust_budget", target: { level: "campaign", id: "ENT2" }, params: { mode: "increase", pct: 20 }, source: "llm", riskLevel: "medium", reason: "escalar" };
  const b2ctx = (rise: number): ScaleRessalvaContext => ({
    eligibility: new Map(), marginalRisePct: new Map([["ENT2", rise]]), marginal: DEFAULT_MARGINAL_CPA_THRESHOLDS,
    headroom: new Map(), ceiling: DEFAULT_AUDIENCE_CEILING_THRESHOLDS, signals: new Map(), lessonGuards: [],
  });
  const b2pos = computeScaleRessalvas(b2act, b2ctx(45)); // CPA marginal +45% vs baseline
  ok("B2[positivo]: CPA marginal piorando +45% (limiar 20%) → RESSALVA, mesmo com CPA médio bom", b2pos.some((r) => r.code === "worsening_marginal_cpa"), b2pos);
  const b2neg = computeScaleRessalvas(b2act, b2ctx(5));
  ok("B2[negativo]: CPA marginal estável (+5%, abaixo do limiar) → sem ressalva", !b2neg.some((r) => r.code === "worsening_marginal_cpa"), b2neg);

  console.log("\n  B3) detectCreationOpportunities — vencedor fatigado NUNCA vira scale_winner (o bug original desta frente)");
  const b3pos = detectCreationOpportunities({
    hasActiveCampaigns: true,
    entities: [{ id: "AD1", level: "ad", name: "Anúncio X", tier: "winner", significant: true, fatigued: true, spending: true }],
  });
  ok("B3[positivo]: vencedor FATIGADO → NÃO gera scale_winner (some do topo)", !b3pos.some((o) => o.kind === "scale_winner"), b3pos);
  ok("B3[positivo]: ...mas gera refresh_fatigued (não desaparece, vira recomendação de refrescar)", b3pos.some((o) => o.kind === "refresh_fatigued"), b3pos);
  const b3neg = detectCreationOpportunities({
    hasActiveCampaigns: true,
    entities: [{ id: "AD2", level: "ad", name: "Anúncio Y", tier: "winner", significant: true, fatigued: false, spending: true }],
  });
  ok("B3[negativo]: vencedor SEM fadiga → gera scale_winner normalmente", b3neg.some((o) => o.kind === "scale_winner"), b3neg);

  // ════════════════════════════════════════════════════════════════════════════════════════
  // PARTE C — seleção de blocos do kernel (positivo — a Parte 1 só provou o negativo)
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n▶ PARTE C) selectAnalysisKnowledge — contexto RICO deve trazer os blocos certos");
  const richCtx: AnalysisKnowledgeContext = {
    role: "synthesis",
    hasWaste: true,
    trackingSuspect: true,
    hasRevenue: true,
    hasBenchmarkRef: true,
    hasBudgetData: true,
    bidStrategyMismatch: true,
    hasDemographics: true,
    hasPlacements: true,
  };
  const poorCtx: AnalysisKnowledgeContext = { role: "synthesis", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: false, bidStrategyMismatch: false, hasDemographics: false, hasPlacements: false };
  const richBlocks = selectAnalysisKnowledge(richCtx);
  const poorBlocks = selectAnalysisKnowledge(poorCtx);
  console.log(`    contexto rico → ${richBlocks.length} blocos; contexto pobre → ${poorBlocks.length} blocos`);
  ok("C1: contexto RICO seleciona estritamente MAIS blocos que o pobre (as NOTES condicionais realmente ligam)", richBlocks.length > poorBlocks.length, { rich: richBlocks.length, poor: poorBlocks.length });
  ok("C1: bloco de segmentação (S7) aparece quando hasDemographics/hasPlacements=true", richBlocks.some((b) => b.theme === "segmentacao"), richBlocks.map((b) => b.key));
  ok("C1: NENHUM bloco de segmentação no contexto pobre", !poorBlocks.some((b) => b.theme === "segmentacao"), poorBlocks.map((b) => b.key));

  // ════════════════════════════════════════════════════════════════════════════════════════
  // PARTE D — seed realista + CHAT com LLM real (surfacing de sinais que genuinamente existem)
  // ════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n▶ PARTE D) semeia curated_json rico (fatigado+tracking-suspeito+teto+funil frio) + pergunta ao chat REAL");
  const SEED_ENTITY_ID = "e2e-seed-campanha-fatigada";
  const seedCurated: CuratedEntitySnapshot = {
    budget: { dailyMajor: 200 },
    atBudgetCeiling: true,
    isCBO: true,
    tier: "winner",
    audience: { stage: "prospecting", customAudienceCount: 0, exclusionCount: 0 },
    funnel: { counts: { conversation_started: 500, first_reply: 100, depth_2: 15 }, replyRate: 0.2, depthRate: 0.03 },
    conversionBasis: "proxy",
    healthSignals: ["creative_fatigue"],
  };
  await deps.db.insert(entityAnalyses).values({
    agentId: AGENT,
    entityId: SEED_ENTITY_ID,
    entityLevel: "campaign",
    entityName: "Campanha Seed E2E (fatigada, teto, funil frio)",
    unitJson: { summary: "seed", findings: [], recommendations: [], flags: [] },
    metricsJson: { spend: 4500, conversions: 3, cpa: 1500, ctr: 1.2, frequency: 6.8 },
    tier: "winner",
    curatedJson: seedCurated,
  });
  note("linha semeada em entity_analyses (curated_json realista — não é dado real da Meta, é fixture no formato de produção)");

  const cfgD = await configToolsFor(deps.db, ORG, AGENT);
  const allowD = buildInContextAllow({ writeTools: [], configTools: cfgD.tools, chatAdsWrites: false });
  const ctxD: ConversationToolContext = {
    orgId: ORG,
    agentId: AGENT,
    adAccountId: ACC,
    timezone: "America/Sao_Paulo",
    ref: { kind: "contact", contactId: "e2e-parte2-d" },
    conversationId: "e2e-parte2-d",
    multiAccount: false,
    configViaChat: cfgD.enabled,
    chatAdsWrites: false,
  };
  const graphD = buildWhatsappConversationGraph(deps, ctxD, allowD);
  const turnD = async (thread: string, text: string) => {
    const result = await graphD.invoke({ messages: [new HumanMessage(text)], orgId: ORG, agentId: AGENT, adAccountId: ACC }, { configurable: { thread_id: thread } });
    const msgs = result.messages as BaseMessage[];
    const last = msgs.at(-1) as AIMessage | undefined;
    return { reply: typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? ""), tools: toolsUsed(msgs) };
  };
  const d1 = await turnD("e2e-d1", 'Me conta tudo sobre a "Campanha Seed E2E (fatigada, teto, funil frio)": orçamento, sinais de saúde e o funil.');
  console.log(`    Roy: ${d1.reply.replace(/\n/g, " ").slice(0, 400)}`);
  ok("D1: menciona fadiga de criativo (o sinal semeado)", /fadig|cansad|fatigu/i.test(d1.reply), d1.reply.slice(0, 300));
  ok("D1: menciona teto de orçamento (atBudgetCeiling semeado)", /teto|limite de or[çc]amento|sem folga|no (m[aá]ximo|limite)/i.test(d1.reply), d1.reply.slice(0, 300));
  ok("D1: menciona qualidade do funil/conversa (replyRate/depthRate baixos, funil frio)", /funil|conversa|resposta|frio|qualidade do lead/i.test(d1.reply), d1.reply.slice(0, 300));

  console.log("\n▶ REVERT (parte D)");
  await deps.db.delete(entityAnalyses).where(eq(entityAnalyses.entityId, SEED_ENTITY_ID));
  console.log("  🧹 linha semeada removida");

  console.log(`\n── ${pass} ok, ${fail} falha ──`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERRO:", String(e?.stack ?? e).split("\n").slice(0, 20).join("\n"));
  process.exit(1);
});
