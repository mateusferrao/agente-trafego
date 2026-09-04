/**
 * E2E REAL diz×faz — FLUXO DE APROVAÇÃO POR CHAT (LLM real, stress). Seed de approvals fake em
 * entidades REAIS (My QuickStart), dry_run ON, e dirige o Grafo B (LLM real) por TODOS os caminhos:
 * listar, aprovar o CERTO (inspeciona o id no tool_call), rejeitar, AMBÍGUO→pergunta (não chuta),
 * inexistente→honesto, "aprova tudo". `approve` ENFILEIRA (não aplica no E2E) → sem escrita real.
 * Limpa os approvals + restaura guardrail no fim.
 * Rodar: cd apps/worker && npx tsx --env-file=<scratch>/.env.e2e e2e-dizfaz-approvals-chat.ts
 */
import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { and, eq, inArray } from "drizzle-orm";
import { approvals, guardrailConfigs, agentToolBindings } from "@trafego/db";
import { ACTION_PARAM_TARGETING, type Action, type ApprovalId, type OrgId, type AgentId, type RunId, type TargetingSpec } from "@trafego/shared";
import { buildComposition } from "./src/composition.js";
import { buildWhatsappConversationGraph } from "./src/graphs/whatsapp-conversation/graph.js";
import type { ConversationToolContext } from "./src/graphs/whatsapp-conversation/tools.js";
import { buildInContextAllow, configToolsFor } from "./src/modules/conversation/turn.js";
import { loadAgentContext } from "./src/modules/conversation/draft-proposal.js";

const ORG = "e87fb1fb-6ce9-46fa-af92-354a814b6285";
const AGENT = "c7dd837e-a06b-4d19-a2f0-b2c5e07e4d9f"; // My QuickStart
const ACC = "a8cfff3a-b1e7-486c-8024-fb1e5cd1ec55";

let pass = 0, fail = 0;
const findings: string[] = [];
const ok = (n: string, c: boolean, d?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 300) : ""); findings.push(n); } };
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

function toolCalls(messages: readonly BaseMessage[]): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const m of messages) { const tc = (m as AIMessage).tool_calls; if (Array.isArray(tc)) for (const c of tc) out.push({ name: c.name, args: (c.args ?? {}) as Record<string, unknown> }); }
  return out;
}
const approvedIds = (tcs: { name: string; args: Record<string, unknown> }[]) => tcs.filter((t) => t.name === "approve").flatMap((t) => (t.args["approvalIds"] as string[]) ?? []);
const rejectedIds = (tcs: { name: string; args: Record<string, unknown> }[]) => tcs.filter((t) => t.name === "reject").flatMap((t) => (t.args["approvalIds"] as string[]) ?? []);

async function main() {
  const deps = await buildComposition();
  const ap = deps.ports.approval;
  const ac = await loadAgentContext(deps, { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" });
  if (!ac) throw new Error("sem contexto");
  const camps = (await deps.ports.ads.listEntities(ac.ref, "campaign")).filter((c) => c.status === "active").slice(0, 3);
  if (camps.length < 3) throw new Error("preciso de 3 campanhas ativas p/ o stress");
  console.log("Campanhas-alvo:", camps.map((c) => `${c.name.slice(0, 24)} (${c.id})`).join(" | "));

  // setup: dry_run ON + adjust_audience habilitado
  const [gr] = await deps.db.select().from(guardrailConfigs).where(and(eq(guardrailConfigs.agentId, AGENT), eq(guardrailConfigs.orgId, ORG))).limit(1);
  const origAllowed = (gr?.allowedActions ?? ["pause_entity", "resume_entity", "adjust_budget", "set_status"]) as string[];
  const origDryRun = gr?.dryRun ?? false;
  const hadGr = Boolean(gr);
  if (hadGr) await deps.db.update(guardrailConfigs).set({ dryRun: true, allowedActions: [...new Set([...origAllowed, "adjust_audience"])] }).where(and(eq(guardrailConfigs.agentId, AGENT), eq(guardrailConfigs.orgId, ORG)));
  else await deps.db.insert(guardrailConfigs).values({ orgId: ORG, agentId: AGENT, dryRun: true, allowedActions: [...origAllowed, "adjust_audience"] });
  await deps.db.insert(agentToolBindings).values({ orgId: ORG, agentId: AGENT, toolKey: "adjust_audience", mode: "enabled" }).onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode: "enabled" } });

  // seed: pausar camp0, orçamento camp1, público camp2 — nomes reconhecíveis pro chat referenciar.
  const spec: TargetingSpec = { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], ageMin: 25, ageMax: 45 };
  const mk = (type: Action["type"], c: { id: string; name: string }, params: Record<string, unknown>): Action => ({ id: `e2e-${type}-${c.id}`, type, target: { level: "campaign", id: c.id, name: c.name }, params, source: "llm", riskLevel: "medium", reason: "e2e chat" });
  const seeds: Record<string, ApprovalId> = {};
  const seedList: Array<[string, Action]> = [
    ["pause", mk("pause_entity", camps[0]!, {})],
    ["budget", mk("adjust_budget", camps[1]!, { mode: "decrease", pct: 20, currentMinor: 5000 })],
    ["audience", mk("adjust_audience", camps[2]!, { [ACTION_PARAM_TARGETING]: spec })],
  ];
  for (const [k, action] of seedList) { const a = await ap.upsertPending({ orgId: ORG as OrgId, agentId: AGENT as AgentId, runId: null as RunId | null, action, expiresAt }); seeds[k] = a.id as ApprovalId; }
  console.log("Seedado:", Object.entries(seeds).map(([k, v]) => `${k}=${v.slice(0, 8)}`).join(" "));

  const cfg = await configToolsFor(deps.db, ORG, AGENT);
  const allow = buildInContextAllow({ writeTools: [], configTools: cfg.tools, chatAdsWrites: false });
  const ctx: ConversationToolContext = { orgId: ORG, agentId: AGENT, adAccountId: ACC, timezone: "America/Sao_Paulo", ref: { kind: "contact", contactId: "e2e-appr-chat" }, conversationId: "e2e-appr-chat", multiAccount: false, configViaChat: cfg.enabled, chatAdsWrites: false };
  const graph = buildWhatsappConversationGraph(deps, ctx, allow);
  const turn = async (thread: string, text: string) => {
    const r = await graph.invoke({ messages: [new HumanMessage(text)], orgId: ORG, agentId: AGENT, adAccountId: ACC }, { configurable: { thread_id: thread } });
    const msgs = r.messages as BaseMessage[];
    const last = msgs.at(-1) as AIMessage | undefined;
    const reply = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    return { reply, tcs: toolCalls(msgs) };
  };
  const show = (l: string, r: { reply: string; tcs: { name: string }[] }) => console.log(`  [${l}] tools=[${r.tcs.map((t) => t.name).join(",")}]\n    Roy: ${r.reply.replace(/\n/g, " ").slice(0, 300)}`);

  try {
    // 1) LISTAR
    console.log("\n▶ 1) listar pendências");
    const q1 = await turn("a1", "Quais aprovações estão pendentes agora?");
    show("listar", q1);
    ok("1: chamou list_pending", q1.tcs.some((t) => t.name === "list_pending"));
    ok("1: menciona as 3 (pausar/orçamento/público) sem inventar", /paus/i.test(q1.reply) && /orçament|budget/i.test(q1.reply) && /públic/i.test(q1.reply), q1.reply.slice(0, 200));

    // 2) APROVAR ESPECÍFICO (o de pausar) — tem que aprovar o ID CERTO
    console.log("\n▶ 2) aprovar ESPECÍFICO — 'pode aprovar a de pausar'");
    const q2 = await turn("a2", `Pode aprovar a de pausar a campanha "${camps[0]!.name}".`);
    show("aprovar-pausar", q2);
    ok("2: aprovou o approval CERTO (o de pausar), não outro", approvedIds(q2.tcs).includes(seeds["pause"]!), { aprovados: approvedIds(q2.tcs), esperado: seeds["pause"] });
    ok("2: NÃO aprovou os outros (orçamento/público)", !approvedIds(q2.tcs).includes(seeds["budget"]!) && !approvedIds(q2.tcs).includes(seeds["audience"]!));

    // 3) AMBÍGUO — "aprova" sem dizer qual, com 2 ainda pendentes → PERGUNTA (não chuta)
    console.log("\n▶ 3) AMBÍGUO — 'aprova' com 2 pendentes → pergunta, não chuta");
    const q3 = await turn("a3", "Aprova.");
    show("ambiguo", q3);
    ok("3: NÃO aprovou nada às cegas (0 approve OU perguntou qual)", approvedIds(q3.tcs).length === 0 || /qual|quais|duas|orçament.*públic|públic.*orçament/i.test(q3.reply), { aprovados: approvedIds(q3.tcs), reply: q3.reply.slice(0, 160) });

    // 4) REJEITAR ESPECÍFICO (o de orçamento)
    console.log("\n▶ 4) rejeitar ESPECÍFICO — 'rejeita a de orçamento'");
    const q4 = await turn("a4", "Rejeita a de orçamento.");
    show("rejeitar", q4);
    ok("4: rejeitou o approval CERTO (o de orçamento)", rejectedIds(q4.tcs).includes(seeds["budget"]!), { rejeitados: rejectedIds(q4.tcs), esperado: seeds["budget"] });
    const budAfter = await ap.getById(seeds["budget"]!);
    ok("4: o de orçamento saiu de pendente (rejected)", budAfter?.status === "rejected", { status: budAfter?.status });

    // 5) INEXISTENTE — pedir aprovar algo que não há
    console.log("\n▶ 5) inexistente — 'aprova a de duplicar a campanha'");
    const q5 = await turn("a5", "Aprova a de duplicar a campanha de vendas.");
    show("inexistente", q5);
    ok("5: não inventa aprovação (não aprova nada + reconhece que não há)", approvedIds(q5.tcs).length === 0, { aprovados: approvedIds(q5.tcs) });
  } finally {
    // cleanup
    console.log("\n▶ cleanup");
    await deps.db.delete(approvals).where(inArray(approvals.id, Object.values(seeds)));
    if (hadGr) await deps.db.update(guardrailConfigs).set({ dryRun: origDryRun, allowedActions: origAllowed }).where(and(eq(guardrailConfigs.agentId, AGENT), eq(guardrailConfigs.orgId, ORG)));
    else await deps.db.delete(guardrailConfigs).where(and(eq(guardrailConfigs.agentId, AGENT), eq(guardrailConfigs.orgId, ORG)));
    await deps.db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "adjust_audience")));
    console.log("   ✅ restaurado");
  }

  console.log(`\n═══ APROVAÇÃO POR CHAT: ${pass} ok · ${fail} falhas ═══`);
  if (findings.length) { console.log("APONTAMENTOS:"); for (const f of findings) console.log("  ⚠️ " + f); }
  await deps.shutdown?.();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("APPROVALS-CHAT erro:", e); process.exit(1); });
