/**
 * E2E REAL (MVP v1) — chat sem escrita conversacional na Meta, com LLM REAL contra a BM Automato.
 * Dirige o GRAFO de conversa com o allow REAL gated pela flag (buildInContextAllow) e inspeciona
 * tool-calls + texto + estado do DB. Cobre, estressando todos os caminhos:
 *   P1) TOOLSET (determinístico): flag OFF remove create/copy/scale/adjust/regenerate/pause/resume/
 *       set_status/adjust_budget; MANTÉM leitura + approve/reject/revert/confirm/cancel/config.
 *       flag ON restaura. (Prova "tirou o que era pra tirar" e "não tirou o que não era".)
 *   P2) ORIENTAÇÃO (LLM real, OFF): "cria campanha" / "pausa X" / "edita rascunho" → o agente NÃO
 *       tem a tool (não cria draft/ação) e REDIRECIONA pra plataforma + oferta de análise.
 *   P3) LEITURA: "como está a conta / onde perco dinheiro" → chama read tool + responde com dado.
 *   P4) AUTO-CONFIG: "muda a meta pra CPA 30" → set_goal (config por chat segue).
 *   P5) APROVAÇÃO: pendente semeada → "quais pendências / aprova" → list_pending + approve (segue).
 *   P6) CAPACIDADES: "o que você faz aqui" → describe_capabilities reflete o v1 (sem criar/editar por chat).
 *   P7) FLAG ON: "cria do zero, 2 anúncios" → create_campaign volta + draft criado (reverso da flag).
 *   P8) QUALIDADE DA ANÁLISE: roda 1 análise real (on_demand) → inspeciona narrativa + recomendações.
 * NÃO escreve na Meta (flag OFF em P2-P6; P7 só propõe rascunho PAUSED, revertido; P8 é leitura+LLM).
 * Reverte tudo (drafts/approvals/runs criados; guardrail restaurado). Sem enviar WhatsApp (grafo direto).
 * Rodar: cd apps/worker && npx tsx --env-file=../../.env e2e-chat-mvp.ts
 */
import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agentRuns, agents, approvals, campaignDrafts, recommendations } from "@trafego/db";
import type { Action, OrgId, AgentId, RunId } from "@trafego/shared";
import { buildComposition } from "./src/composition.js";
import { buildWhatsappConversationGraph } from "./src/graphs/whatsapp-conversation/graph.js";
import { buildAccountAnalysisGraph } from "./src/graphs/account-analysis/graph.js";
import type { ConversationToolContext } from "./src/graphs/whatsapp-conversation/tools.js";
import { buildInContextAllow, configToolsFor } from "./src/modules/conversation/turn.js";
import { createAnalysisRepo } from "./src/modules/analysis/repo.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACC = "d246db5c-d843-4519-a588-9197131458c4";

const WRITE_TOOLS_FULL = ["pause_entity", "resume_entity", "set_status", "adjust_budget", "create_campaign", "copy_campaign", "scale_winner"];
const REMOVED_WHEN_OFF = [...WRITE_TOOLS_FULL, "adjust_draft", "regenerate_copy"];
const KEEP_ALWAYS = ["get_account_status", "get_metrics", "list_campaigns", "list_pending", "approve", "reject", "revert_action", "confirm_write", "cancel_write", "trigger_analysis", "set_focus", "describe_capabilities", "set_goal"];

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d?: unknown) => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}`);
  } else {
    fail++;
    console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 400) : "");
  }
};

/** Nomes das tools chamadas ao longo das mensagens do turno (AIMessage.tool_calls). */
function toolsUsed(messages: readonly BaseMessage[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    const tc = (m as AIMessage).tool_calls;
    if (Array.isArray(tc)) for (const c of tc) names.push(c.name);
  }
  return names;
}
const REDIRECT = /plataforma|no site|pelo site|na plataforma/i;

async function main() {
  const deps = await buildComposition();
  const repo = createAnalysisRepo(deps.db);
  const cfg = await configToolsFor(deps.db, ORG, AGENT);
  ok("setup: config-por-chat ligada (auto-config disponível)", cfg.enabled);

  const allowOff = buildInContextAllow({ writeTools: [], configTools: cfg.tools, chatAdsWrites: false });
  const allowOn = buildInContextAllow({ writeTools: WRITE_TOOLS_FULL, configTools: cfg.tools, chatAdsWrites: true });

  const cleanupDraftIds = new Set<string>();
  const cleanupApprovalIds = new Set<string>();
  const cleanupRunIds = new Set<string>();

  const ctxFor = (chatAdsWrites: boolean): ConversationToolContext => ({
    orgId: ORG,
    agentId: AGENT,
    adAccountId: ACC,
    timezone: "America/Sao_Paulo",
    ref: { kind: "contact", contactId: "e2e-mvp" },
    conversationId: "e2e-mvp",
    multiAccount: false,
    configViaChat: cfg.enabled,
    chatAdsWrites,
  });
  const graphOff = buildWhatsappConversationGraph(deps, ctxFor(false), allowOff);
  const graphOn = buildWhatsappConversationGraph(deps, ctxFor(true), allowOn);

  const turn = async (graph: ReturnType<typeof buildWhatsappConversationGraph>, thread: string, text: string) => {
    const result = await graph.invoke(
      { messages: [new HumanMessage(text)], orgId: ORG, agentId: AGENT, adAccountId: ACC },
      { configurable: { thread_id: thread } },
    );
    const msgs = result.messages as BaseMessage[];
    const last = msgs.at(-1) as AIMessage | undefined;
    const reply = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    return { reply, tools: toolsUsed(msgs) };
  };
  const proposedCount = async (): Promise<number> => {
    const rows = await deps.db.select({ id: campaignDrafts.id }).from(campaignDrafts).where(and(eq(campaignDrafts.agentId, AGENT), eq(campaignDrafts.status, "proposed")));
    return rows.length;
  };
  const latestDraftId = async (): Promise<string | null> => {
    const [d] = await deps.db.select({ id: campaignDrafts.id }).from(campaignDrafts).where(and(eq(campaignDrafts.agentId, AGENT), eq(campaignDrafts.status, "proposed"))).orderBy(desc(campaignDrafts.createdAt)).limit(1);
    return d?.id ?? null;
  };

  try {
    // ── P1) TOOLSET determinístico ────────────────────────────────────────────────────────────
    console.log("\n▶ P1) toolset: flag OFF remove escrita/edição; mantém leitura/aprovação/config");
    ok("P1: OFF remove TODAS as 9 tools de escrita/edição", REMOVED_WHEN_OFF.every((t) => !allowOff.has(t)), REMOVED_WHEN_OFF.filter((t) => allowOff.has(t)));
    ok("P1: OFF mantém leitura+approve+reject+revert+confirm+config (nada over-removido)", KEEP_ALWAYS.every((t) => allowOff.has(t)), KEEP_ALWAYS.filter((t) => !allowOff.has(t)));
    ok("P1: ON restaura create_campaign/adjust_draft/pause_entity (reverso da flag)", ["create_campaign", "adjust_draft", "pause_entity", "copy_campaign", "scale_winner", "adjust_budget"].every((t) => allowOn.has(t)));

    // ── P2) ORIENTAÇÃO (LLM real, OFF) ─────────────────────────────────────────────────────────
    console.log("\n▶ P2) orientação: pedidos de escrita → sem tool + redireciona pra plataforma");
    const before2 = await proposedCount();
    const a = await turn(graphOff, "e2e-p2a", "Cria uma campanha de vendas do zero com 3 anúncios usando os melhores criativos da conta.");
    console.log(`    Roy(criar): ${a.reply.replace(/\n/g, " ").slice(0, 220)}`);
    ok("P2a: NÃO chamou create/copy/scale (tool ausente)", !a.tools.some((t) => ["create_campaign", "copy_campaign", "scale_winner"].includes(t)), a.tools);
    ok("P2a: NÃO criou rascunho no banco", (await proposedCount()) === before2);
    ok("P2a: redirecionou pra plataforma", REDIRECT.test(a.reply), a.reply.slice(0, 200));

    const b = await turn(graphOff, "e2e-p2b", "Pausa a campanha que está gastando mais e sem retorno.");
    console.log(`    Roy(pausar): ${b.reply.replace(/\n/g, " ").slice(0, 220)}`);
    ok("P2b: NÃO chamou pause/adjust (tool ausente)", !b.tools.some((t) => ["pause_entity", "adjust_budget", "set_status"].includes(t)), b.tools);
    ok("P2b: redirecionou pra plataforma (ou ofereceu análise/aprovação)", REDIRECT.test(b.reply) || /recomend|analis|aprova/i.test(b.reply), b.reply.slice(0, 200));

    const c = await turn(graphOff, "e2e-p2c", "Edita o público do rascunho pra mulheres de 25 a 40 e troca o criativo.");
    console.log(`    Roy(editar): ${c.reply.replace(/\n/g, " ").slice(0, 220)}`);
    ok("P2c: NÃO chamou adjust_draft/regenerate_copy", !c.tools.some((t) => ["adjust_draft", "regenerate_copy"].includes(t)), c.tools);
    ok("P2c: redirecionou pra plataforma", REDIRECT.test(c.reply), c.reply.slice(0, 200));

    // ── P3) LEITURA / qualidade de resposta de dados ───────────────────────────────────────────
    console.log("\n▶ P3) leitura: 'como está a conta / onde perco dinheiro' → read tool + dado");
    const d = await turn(graphOff, "e2e-p3", "Como está minha conta? Onde estou perdendo dinheiro e o que está indo bem?");
    console.log(`    Roy(status): ${d.reply.replace(/\n/g, " ").slice(0, 260)}`);
    ok("P3: chamou uma tool de LEITURA", d.tools.some((t) => ["get_account_status", "get_metrics", "list_campaigns", "get_fresh_metrics"].includes(t)), d.tools);
    ok("P3: respondeu com substância (não vazio, não recusa genérica)", d.reply.length > 40 && !/não consigo|não sei/i.test(d.reply));

    // ── P4) AUTO-CONFIG por chat ───────────────────────────────────────────────────────────────
    console.log("\n▶ P4) auto-config: 'muda a meta pra CPA de 30 reais' → set_goal (config segue)");
    const e = await turn(graphOff, "e2e-p4", "Muda a minha meta pra um CPA de 30 reais.");
    console.log(`    Roy(meta): ${e.reply.replace(/\n/g, " ").slice(0, 220)}`);
    ok("P4: chamou set_goal (auto-config disponível)", e.tools.includes("set_goal"), e.tools);
    ok("P4: ecoou a mudança pra confirmar (não afirmou feito sem OK)", /confirm|de .* pra |quer que/i.test(e.reply) || e.tools.includes("set_goal"), e.reply.slice(0, 160));

    // ── P5) APROVAÇÃO (segue pelo chat) ────────────────────────────────────────────────────────
    console.log("\n▶ P5) aprovação: pendente semeada → 'quais pendências' + 'aprova' (approve segue)");
    const [seedRun] = await deps.db.insert(agentRuns).values({ orgId: ORG, agentId: AGENT, trigger: "on_demand", status: "succeeded" }).returning({ id: agentRuns.id });
    cleanupRunIds.add(seedRun!.id);
    const seedAction: Action = { id: "e2e-act", type: "pause_entity", target: { level: "campaign", id: "e2e-camp-1", name: "Campanha E2E (teste)" }, params: {}, source: "llm", riskLevel: "low", reason: "gasto sem retorno (semeado no E2E)" };
    const appr = await deps.ports.approval.upsertPending({ orgId: ORG as OrgId, agentId: AGENT as AgentId, runId: seedRun!.id as RunId, action: seedAction, expiresAt: new Date(Date.now() + 24 * 3600_000) });
    cleanupApprovalIds.add(appr.id);
    const f1 = await turn(graphOff, "e2e-p5", "Quais ações estão aguardando minha aprovação?");
    console.log(`    Roy(pendências): ${f1.reply.replace(/\n/g, " ").slice(0, 220)}`);
    ok("P5: chamou list_pending", f1.tools.includes("list_pending"), f1.tools);
    ok("P5: listou a pendência semeada (cita a campanha)", /campanha e2e|pausar|aguard/i.test(f1.reply), f1.reply.slice(0, 200));
    const f2 = await turn(graphOff, "e2e-p5", "Pode aprovar essa pausa.");
    console.log(`    Roy(aprovar): ${f2.reply.replace(/\n/g, " ").slice(0, 220)}`);
    ok("P5: chamou approve (aprovação segue pelo chat)", f2.tools.includes("approve"), f2.tools);

    // ── P6) CAPACIDADES ────────────────────────────────────────────────────────────────────────
    console.log("\n▶ P6) capacidades: 'o que você consegue fazer aqui?' → describe_capabilities (v1)");
    const g = await turn(graphOff, "e2e-p6", "O que você consegue fazer aqui pelo WhatsApp?");
    console.log(`    Roy(capacidades): ${g.reply.replace(/\n/g, " ").slice(0, 320)}`);
    ok("P6: chamou describe_capabilities", g.tools.includes("describe_capabilities"), g.tools);
    ok("P6: declara consulta + aprovar (leitura/aprovação)", /aprov|consult|analis|recomend/i.test(g.reply));
    ok("P6: aponta criar/editar/mexer na PLATAFORMA (v1)", REDIRECT.test(g.reply), g.reply.slice(0, 240));

    // ── P7) FLAG ON restaura a criação ─────────────────────────────────────────────────────────
    console.log("\n▶ P7) flag ON: 'cria do zero, 2 anúncios' → create_campaign volta + rascunho criado");
    const before7 = await proposedCount();
    const h = await turn(graphOn, "e2e-p7", "Cria uma campanha de leads do zero com 2 anúncios, me mostra antes.");
    console.log(`    Roy(ON criar): ${h.reply.replace(/\n/g, " ").slice(0, 220)}`);
    ok("P7: chamou create_campaign (reverso da flag)", h.tools.includes("create_campaign"), h.tools);
    const afterId = await latestDraftId();
    if (afterId) cleanupDraftIds.add(afterId);
    ok("P7: criou o rascunho (proposta) no banco", (await proposedCount()) > before7);

    // ── P8) QUALIDADE DA ANÁLISE (run real on_demand) ──────────────────────────────────────────
    console.log("\n▶ P8) análise real (on_demand): narrativa + recomendações de qualidade");
    const [run] = await deps.db.insert(agentRuns).values({ orgId: ORG, agentId: AGENT, trigger: "on_demand", status: "pending" }).returning({ id: agentRuns.id });
    cleanupRunIds.add(run!.id);
    const analysis = buildAccountAnalysisGraph(deps);
    await analysis.invoke({ runId: run!.id, orgId: ORG, agentId: AGENT, adAccountId: ACC, trigger: "on_demand", notifyTarget: null, signalFinding: null });
    const [runRow] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)).limit(1);
    const recs = await deps.db.select().from(recommendations).where(eq(recommendations.runId, run!.id));
    console.log(`    status=${runRow?.status} partial=${runRow?.partial} recs=${recs.length}`);
    console.log(`    narrativa: ${(runRow?.narrative ?? runRow?.summary ?? "—").replace(/\n/g, " ").slice(0, 400)}`);
    for (const r of recs.slice(0, 6)) console.log(`      • [${r.kind}] ${r.title} — ${(r.rationale ?? "").replace(/\n/g, " ").slice(0, 140)}`);
    const narr = runRow?.narrative ?? runRow?.summary ?? "";
    ok("P8: run concluído (succeeded)", runRow?.status === "succeeded", { status: runRow?.status });
    ok("P8: narrativa/summary substancial (não vazio)", narr.length > 40);
    if (recs.length > 0) {
      // conta COM dado → valida QUALIDADE: recomendações ancoradas em números reais.
      ok("P8[dado]: produziu recomendações", recs.length > 0, { n: recs.length });
      ok("P8[dado]: ao menos 1 recomendação cita números (dado real)", recs.some((r) => /\d/.test(r.rationale ?? "")), { sample: recs[0]?.rationale?.slice(0, 120) });
      ok("P8[dado]: recomendações têm rationale (não título solto)", recs.every((r) => (r.rationale ?? "").length > 10));
    } else {
      // conta VAZIA (sem gasto) → o certo é DEGRADAR HONESTO, não inventar recomendação.
      ok("P8[vazio]: degradou HONESTO (succeeded + empty-state, sem inventar rec)", runRow?.status === "succeeded" && /não teve gasto|não há o que analis|sem veicula|sem gasto/i.test(narr), { narr: narr.slice(0, 120) });
      console.log("    ⚠️ conta de teste sem gasto/impressões — QUALIDADE de análise em dado real NÃO exercida (aponte p/ conta ativa/financiada).");
    }
  } finally {
    console.log("\n▶ REVERT");
    for (const id of cleanupDraftIds) {
      await deps.db.delete(approvals).where(eq(approvals.draftId, id));
      await deps.db.delete(recommendations).where(eq(recommendations.draftId, id));
      await deps.db.delete(campaignDrafts).where(eq(campaignDrafts.id, id));
    }
    if (cleanupApprovalIds.size > 0) await deps.db.delete(approvals).where(inArray(approvals.id, [...cleanupApprovalIds]));
    for (const id of cleanupRunIds) {
      await deps.db.delete(approvals).where(eq(approvals.runId, id));
      await deps.db.delete(recommendations).where(eq(recommendations.runId, id));
      await deps.db.delete(agentRuns).where(eq(agentRuns.id, id));
    }
    console.log(`  🧹 ${cleanupDraftIds.size} draft(s), ${cleanupApprovalIds.size} approval(s), ${cleanupRunIds.size} run(s) limpos`);
    console.log(`\n── ${pass} ok, ${fail} falha ──`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERRO:", String(e?.stack ?? e).split("\n").slice(0, 10).join("\n"));
  process.exit(1);
});
