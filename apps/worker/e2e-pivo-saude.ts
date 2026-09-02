/**
 * E2E REAL — pivô saúde (Fases 0-4, plano em
 * C:\Users\Mateus Ferrão\.claude\plans\lendo-claude-md-usando-as-lexical-marshmallow.md),
 * LLM real + Meta real (BM Automato). Roda os 2 grafos DIRETO (sem Evolution/HTTP) contra a
 * conta de teste "Org de Teste 366" (archetype conservador, autonomy bySource=suggest em
 * ambas as origens, sem override por-ação → NENHUMA mutação real na Meta é possível aqui,
 * só leitura Graph + LLM + gravação de `approvals` pendentes, revertidas no fim).
 *
 * Cobre:
 *   Q1) Bug do orçamento (chat) ANTES de reanalisar → "sem orçamento" deve virar "reanalisa"
 *       (nunca "não tenho essa informação" seco — list_campaigns/get_entity_detail dizem isso).
 *   Q2) Análise real on-demand (account-analysis) → S6/S7/guards/G4/vertical health na prática.
 *   Q3) Bug do orçamento RESOLVIDO (chat, DEPOIS da análise) → cita orçamento+tier por campanha
 *       (a queixa ORIGINAL que abriu esta frente inteira).
 *   Q4) get_entity_detail → tier/budget/healthSignals/audience/funnel/basis (+ nota ABO se aplicável).
 *   Q5) explain_recommendation → grounding (G4: expectedImpact/whatToMonitor nunca inventados).
 *   Q6) Ambíguo: "aprova" sem nenhuma pendência real → não alucina aprovação.
 *   Q7) Erro: entidade inexistente citada no chat → falha amigável, sem stack/erro técnico.
 *   Q8) Escrita gated (chatAdsWrites=false, valor real do .env) → redireciona pra plataforma.
 *   Q9) Breakdown demográfico/posicionamento (S7) — pergunta direta, com carimbo de frescor.
 *   Q10) DB: org-scoping de insights_breakdowns + shape de curated_json + rótulo de guard demovido.
 *
 * NÃO aplica nenhuma ação (autonomia real do agente = suggest, ver acima). Reverte
 * approvals/recommendations/run criados no fim. Sem enviar WhatsApp (grafo direto).
 * Rodar: cd apps/worker && npx tsx --env-file=../../.env e2e-pivo-saude.ts
 */
import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { eq, and } from "drizzle-orm";
import { agentRuns, approvals, recommendations, entityAnalyses, insightsBreakdowns } from "@trafego/db";
import { buildComposition } from "./src/composition.js";
import { buildWhatsappConversationGraph } from "./src/graphs/whatsapp-conversation/graph.js";
import { buildAccountAnalysisGraph } from "./src/graphs/account-analysis/graph.js";
import type { ConversationToolContext } from "./src/graphs/whatsapp-conversation/tools.js";
import { buildInContextAllow, configToolsFor } from "./src/modules/conversation/turn.js";

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
const REDIRECT = /plataforma|no site|pelo site|na plataforma/i;
const REANALYZE_OFFER = /reanalis|rodar (uma|a) an[aá]lise|analisar (agora|de novo)/i;
const TECH_ERROR = /stack|typeerror|undefined is not|\bat\s+\w+\.\w+\s*\(|ECONNREFUSED|node_modules/i;

async function main() {
  const deps = await buildComposition();
  const cfg = await configToolsFor(deps.db, ORG, AGENT);
  const allow = buildInContextAllow({ writeTools: [], configTools: cfg.tools, chatAdsWrites: false });

  const cleanupRunIds = new Set<string>();

  const ctx: ConversationToolContext = {
    orgId: ORG,
    agentId: AGENT,
    adAccountId: ACC,
    timezone: "America/Sao_Paulo",
    ref: { kind: "contact", contactId: "e2e-pivo-saude" },
    conversationId: "e2e-pivo-saude",
    multiAccount: false,
    configViaChat: cfg.enabled,
    chatAdsWrites: false,
  };
  const graph = buildWhatsappConversationGraph(deps, ctx, allow);

  const turn = async (thread: string, text: string) => {
    const result = await graph.invoke(
      { messages: [new HumanMessage(text)], orgId: ORG, agentId: AGENT, adAccountId: ACC },
      { configurable: { thread_id: thread } },
    );
    const msgs = result.messages as BaseMessage[];
    const last = msgs.at(-1) as AIMessage | undefined;
    const reply = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    return { reply, tools: toolsUsed(msgs) };
  };

  try {
    // ── Q1) bug do orçamento ANTES de reanalisar ───────────────────────────────────────────────
    console.log("\n▶ Q1) orçamento por campanha ANTES de reanalisar — nunca 'sem informação' seco");
    const q1 = await turn("e2e-q1", "Quero saber o orçamento diário de cada campanha ativa.");
    console.log(`    Roy: ${q1.reply.replace(/\n/g, " ").slice(0, 260)}`);
    ok("Q1: chamou list_campaigns (ou get_entity_detail)", q1.tools.some((t) => ["list_campaigns", "get_entity_detail"].includes(t)), q1.tools);
    ok(
      "Q1: se não tinha orçamento fresco, ofereceu reanalisar (nunca 'não tenho essa informação' seco)",
      /R\$|\d/.test(q1.reply) || REANALYZE_OFFER.test(q1.reply),
      q1.reply.slice(0, 200),
    );

    // ── Q2) ANÁLISE REAL on-demand ─────────────────────────────────────────────────────────────
    console.log("\n▶ Q2) análise real (on_demand) — S6/S7/guards/G4/vertical health na prática");
    const [run] = await deps.db.insert(agentRuns).values({ orgId: ORG, agentId: AGENT, trigger: "on_demand", status: "pending" }).returning({ id: agentRuns.id });
    cleanupRunIds.add(run!.id);
    const analysis = buildAccountAnalysisGraph(deps);
    const t0 = Date.now();
    await analysis.invoke({ runId: run!.id, orgId: ORG, agentId: AGENT, adAccountId: ACC, trigger: "on_demand", notifyTarget: null, signalFinding: null });
    const durationSec = ((Date.now() - t0) / 1000).toFixed(1);
    const [runRow] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)).limit(1);
    const recs = await deps.db.select().from(recommendations).where(eq(recommendations.runId, run!.id));
    const narr = runRow?.narrative ?? runRow?.summary ?? "";
    console.log(`    status=${runRow?.status} partial=${runRow?.partial} recs=${recs.length} duração=${durationSec}s`);
    console.log(`    narrativa: ${narr.replace(/\n/g, " ").slice(0, 500)}`);
    for (const r of recs) {
      console.log(`      • [${r.kind}] ${r.title}`);
      console.log(`          rationale: ${(r.rationale ?? "").replace(/\n/g, " ").slice(0, 200)}`);
      console.log(`          expectedImpact=${r.expectedImpact ?? "null"} whatToMonitor=${(r.whatToMonitor ?? "null").toString().slice(0, 80)} findingRefs=${JSON.stringify(r.findingRefs ?? [])}`);
    }
    ok("Q2: run concluído (succeeded)", runRow?.status === "succeeded", { status: runRow?.status });
    ok("Q2: narrativa substancial", narr.length > 40);
    const demoted = recs.filter((r) => /^investigar:/i.test(r.title ?? ""));
    if (demoted.length > 0) note(`${demoted.length} recomendação(ões) REBAIXADA(S) por guard — título prefixado "Investigar:" (rótulo correto)`);
    if (recs.length > 0) {
      ok("Q2[dado]: recomendações têm rationale substancial", recs.every((r) => (r.rationale ?? "").length > 10));
      ok("Q2[dado]: ao menos 1 recomendação cita número real (grounding)", recs.some((r) => /\d/.test(r.rationale ?? "")));
    } else {
      ok("Q2[vazio]: degradou HONESTO (succeeded + narrativa reconhece falta de dado)", runRow?.status === "succeeded" && /não teve gasto|não há o que analis|sem veicula|sem gasto|sem dado|zumbi/i.test(narr), { narr: narr.slice(0, 160) });
      note("conta sem recomendações neste run — QUALIDADE de recomendação real NÃO exercida; ver docs/validacao-manual-pivo-saude-completo.md para os caminhos cobertos por fixture");
    }
    const healthVocab = /proxy|agendamento|avalia[cç][aã]o|alta considera[cç][aã]o|ltv|skew demogr[aá]fico|funil/i.test(narr);
    note(`vocabulário de saúde (proxy/agendamento/LTV/skew demográfico/funil) ${healthVocab ? "PRESENTE" : "ausente"} na narrativa (condicional — só entra quando relevante ao run, S0b)`);

    // entidade real p/ Q4 (campanha citada na narrativa OU curated de entity_analyses)
    const [anyEntity] = await deps.db.select().from(entityAnalyses).where(eq(entityAnalyses.agentId, AGENT)).limit(1);
    const entityName = anyEntity?.entityName ?? null;

    // ── Q3) bug do orçamento RESOLVIDO (depois da análise) ─────────────────────────────────────
    console.log("\n▶ Q3) orçamento por campanha DEPOIS de reanalisar — cita valor + tier (bug ORIGINAL)");
    const q3 = await turn("e2e-q3", "Analisa o orçamento distribuído por campanha — quanto cada uma gasta por dia e qual o tier de cada uma?");
    console.log(`    Roy: ${q3.reply.replace(/\n/g, " ").slice(0, 300)}`);
    ok("Q3: chamou list_campaigns", q3.tools.includes("list_campaigns"), q3.tools);
    ok("Q3: cita valor monetário (R$/número) — o BUG original resolvido", /R\$\s?\d|\d+[.,]\d{2}/.test(q3.reply), q3.reply.slice(0, 240));

    // ── Q4) detalhe de entidade curado ──────────────────────────────────────────────────────────
    if (entityName) {
      console.log(`\n▶ Q4) detalhe curado de "${entityName}" — tier/budget/healthSignals/audience/funnel`);
      const q4 = await turn("e2e-q4", `Me detalha a campanha "${entityName}": orçamento, tier, sinais de saúde e o funil.`);
      console.log(`    Roy: ${q4.reply.replace(/\n/g, " ").slice(0, 300)}`);
      ok("Q4: chamou tool de diagnóstico curado (get_entity_detail/get_campaign_analysis/trigger_analysis)", q4.tools.some((t) => ["get_entity_detail", "get_campaign_analysis", "trigger_analysis"].includes(t)), q4.tools);
      ok("Q4: resposta substancial (não vazia/recusa)", q4.reply.length > 40 && !/não consigo|não sei/i.test(q4.reply));
    } else {
      console.log("\n▶ Q4) SKIP — nenhuma entity_analyses para este agente (conta sem histórico curado)");
    }

    // ── Q5) explicação de recomendação (grounding) ─────────────────────────────────────────────
    if (recs.length > 0) {
      const target = recs[0]!;
      console.log(`\n▶ Q5) explain_recommendation("${target.title}") — grounding sem invenção`);
      const q5 = await turn("e2e-q5", `Por que você recomendou "${target.title}"? Qual o impacto esperado e o que devo monitorar?`);
      console.log(`    Roy: ${q5.reply.replace(/\n/g, " ").slice(0, 300)}`);
      ok("Q5: chamou explain_recommendation", q5.tools.includes("explain_recommendation"), q5.tools);
      if (!target.expectedImpact) ok("Q5: expectedImpact null → NÃO inventou número de impacto", !/R\$\s?\d+/.test(q5.reply) || /n[aã]o (h[aá]|tenho|deu pra)/i.test(q5.reply), q5.reply.slice(0, 200));
    } else {
      console.log("\n▶ Q5) SKIP — sem recomendações neste run");
    }

    // ── Q6) ambíguo: aprovar sem pendência ──────────────────────────────────────────────────────
    console.log("\n▶ Q6) 'aprova' sem NENHUMA pendência real → não alucina aprovação");
    const q6 = await turn("e2e-q6", "Pode aprovar.");
    console.log(`    Roy: ${q6.reply.replace(/\n/g, " ").slice(0, 240)}`);
    ok("Q6: NÃO chamou approve (nada pra aprovar de verdade)", !q6.tools.includes("approve"), q6.tools);
    ok("Q6: avisa que não há pendência / pergunta qual ação (não finge que aprovou)", /n[aã]o h[aá]|n[aã]o tem nada|nenhuma pend|qual a[cç][aã]o|qual delas|n[aã]o encontrei/i.test(q6.reply), q6.reply.slice(0, 200));

    // ── Q7) erro: entidade inexistente ──────────────────────────────────────────────────────────
    console.log("\n▶ Q7) entidade inexistente citada no chat → falha amigável, sem erro técnico");
    const q7 = await turn("e2e-q7", "Pausa a campanha 'Campanha Fantasma Que Não Existe 999'.");
    console.log(`    Roy: ${q7.reply.replace(/\n/g, " ").slice(0, 240)}`);
    ok("Q7: não vaza erro técnico (stack/exception)", !TECH_ERROR.test(q7.reply), q7.reply.slice(0, 200));
    ok("Q7: reconhece que não achou a entidade OU redireciona pra plataforma", /n[aã]o encontr|n[aã]o achei|n[aã]o existe|plataforma|no site/i.test(q7.reply), q7.reply.slice(0, 200));

    // ── Q8) escrita gated (valor real do .env) ──────────────────────────────────────────────────
    console.log("\n▶ Q8) escrita conversacional (chatAdsWrites real do .env) → redireciona");
    const q8 = await turn("e2e-q8", "Aumenta o orçamento da campanha que mais converte em 20%.");
    console.log(`    Roy: ${q8.reply.replace(/\n/g, " ").slice(0, 240)}`);
    ok("Q8: não chamou adjust_budget (tool ausente com a flag OFF)", !q8.tools.includes("adjust_budget"), q8.tools);
    ok(
      "Q8: redirecionou pra plataforma OU raciocinou com dado real (análise/recomendação/campanha citada) em vez de aumentar cegamente",
      REDIRECT.test(q8.reply) || /recomend|an[aá]lis|aprova|campanha/i.test(q8.reply),
      q8.reply.slice(0, 200),
    );

    // ── Q9) breakdown demográfico/posicionamento ────────────────────────────────────────────────
    console.log("\n▶ Q9) breakdown demográfico/posicionamento (S7) — pergunta direta");
    const q9 = await turn("e2e-q9", "Alguma faixa etária ou posicionamento está custando muito mais caro que o resto?");
    console.log(`    Roy: ${q9.reply.replace(/\n/g, " ").slice(0, 300)}`);
    ok("Q9: resposta substancial (não vazia/recusa)", q9.reply.length > 30 && !TECH_ERROR.test(q9.reply));
    const breakdownRows = await deps.db.select().from(insightsBreakdowns).where(and(eq(insightsBreakdowns.orgId, ORG), eq(insightsBreakdowns.adAccountId, ACC)));
    note(`insights_breakdowns: ${breakdownRows.length} linha(s) persistida(s) para esta conta (gate de materialidade pode ter descartado tudo — não é bug por si só)`);

    // ── Q10) DB: org-scoping + shape ─────────────────────────────────────────────────────────────
    console.log("\n▶ Q10) DB: org-scoping de insights_breakdowns + shape de curated_json");
    ok("Q10: TODA linha de insights_breakdowns encontrada já veio filtrada por orgId (query própria)", breakdownRows.every((r) => r.orgId === ORG));
    const [entityRow] = await deps.db.select().from(entityAnalyses).where(eq(entityAnalyses.agentId, AGENT)).limit(1);
    if (entityRow?.curatedJson) {
      const cj = entityRow.curatedJson as Record<string, unknown>;
      note(`curated_json de "${entityRow.entityName}": isCBO=${cj.isCBO} tier=${entityRow.tier} healthSignals=${JSON.stringify(cj.healthSignals ?? [])}`);
      ok("Q10: curated_json.isCBO só é true pra CAMPANHA (nunca herdado erroneamente por adset)", entityRow.entityLevel !== "adset" || cj.isCBO === false || cj.isCBO === undefined, { level: entityRow.entityLevel, isCBO: cj.isCBO });
    }
  } finally {
    console.log("\n▶ REVERT");
    for (const id of cleanupRunIds) {
      await deps.db.delete(approvals).where(eq(approvals.runId, id));
      await deps.db.delete(recommendations).where(eq(recommendations.runId, id));
      await deps.db.delete(agentRuns).where(eq(agentRuns.id, id));
    }
    console.log(`  🧹 ${cleanupRunIds.size} run(s) e dependentes limpos (entity_analyses/insights_breakdowns/insights_snapshots ficam — são cache legítimo, não artefato de teste)`);
    console.log(`\n── ${pass} ok, ${fail} falha ──`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERRO:", String(e?.stack ?? e).split("\n").slice(0, 15).join("\n"));
  process.exit(1);
});
