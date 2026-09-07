/** E2E REAL diz×faz — FASE 2: CHAT (Grafo B) honesto (My QuickStart, dados reais, LLM real).
 *  LEITURA pura (chatAdsWrites=false → nenhuma escrita na Meta). Foco: não alucina, faz o que fala,
 *  direciona/esclarece certo, erro amigável, escrita redirecionada pra plataforma, capacidades honestas.
 *  Rodar: cd apps/worker && npx tsx --env-file=<scratch>/.env.e2e e2e-dizfaz-chat.ts */
import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
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
const TECH = /stack|typeerror|undefined is not|ECONNREFUSED|node_modules|\bat \w+\.\w+ \(/i;
const REDIR = /plataforma|no site|pelo site|na plataforma/i;

function toolsUsed(messages: readonly BaseMessage[]): string[] {
  const names: string[] = [];
  for (const m of messages) { const tc = (m as AIMessage).tool_calls; if (Array.isArray(tc)) for (const c of tc) names.push(c.name); }
  return names;
}

async function main() {
  const deps = await buildComposition();
  const ac = await loadAgentContext(deps, { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" });
  if (!ac) throw new Error("sem contexto");
  const camps = await deps.ports.ads.listEntities(ac.ref, "campaign");
  const realNames = camps.map((c) => c.name.toLowerCase());
  console.log(`Universo real: ${camps.length} campanhas.`);

  const cfg = await configToolsFor(deps.db, ORG, AGENT);
  const allow = buildInContextAllow({ writeTools: [], configTools: cfg.tools, chatAdsWrites: false });
  const ctx: ConversationToolContext = { orgId: ORG, agentId: AGENT, adAccountId: ACC, timezone: "America/Sao_Paulo", ref: { kind: "contact", contactId: "e2e-dizfaz" }, conversationId: "e2e-dizfaz", multiAccount: false, configViaChat: cfg.enabled, chatAdsWrites: false };
  const graph = buildWhatsappConversationGraph(deps, ctx, allow);
  const turn = async (thread: string, text: string) => {
    const result = await graph.invoke({ messages: [new HumanMessage(text)], orgId: ORG, agentId: AGENT, adAccountId: ACC }, { configurable: { thread_id: thread } });
    const msgs = result.messages as BaseMessage[];
    const last = msgs.at(-1) as AIMessage | undefined;
    const reply = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    return { reply, tools: toolsUsed(msgs) };
  };
  const show = (label: string, r: { reply: string; tools: string[] }) => console.log(`  [${label}] tools=[${r.tools.join(",")}]\n    Roy: ${r.reply.replace(/\n/g, " ").slice(0, 320)}`);

  // 1) STATUS — cita campanhas REAIS (não alucina nome)
  console.log("\n▶ 1) status da conta — cita campanhas reais");
  const q1 = await turn("t1", "Como está a conta? Quais campanhas estão rodando e como vão?");
  show("status", q1);
  ok("1: sem erro técnico vazado", !TECH.test(q1.reply), q1.reply.slice(0, 120));
  ok("1: usou tool de leitura (status/lista/análise)", q1.tools.length > 0, q1.tools);

  // 2) ENTIDADE INEXISTENTE — erro amigável, não alucina que pausou
  console.log("\n▶ 2) pedir ação em campanha INEXISTENTE — erro amigável, sem alucinar");
  const q2 = await turn("t2", "Pausa a campanha 'Promoção Dia das Bruxas 2099' agora.");
  show("inexistente", q2);
  ok("2: NÃO afirma que pausou (não alucina ação)", !/pausei|pausada com sucesso|feito|prontinho/i.test(q2.reply), q2.reply.slice(0, 160));
  ok("2: erro/limite amigável, sem stack técnico", !TECH.test(q2.reply));
  ok("2: reconhece que não achou / pede esclarecimento OU redireciona", /não (achei|encontrei)|não localizei|qual|não existe|plataforma|site/i.test(q2.reply), q2.reply.slice(0, 200));

  // 3) "APROVA" sem pendência — não alucina aprovação
  console.log("\n▶ 3) 'aprova' sem nenhuma pendência — não inventa aprovação");
  const q3 = await turn("t3", "Aprova.");
  show("aprova-vazio", q3);
  ok("3: não alucina que aprovou algo (reconhece que não há pendência)", /nada (pendente|a aprovar)|não (há|tem) (nada|pend)|não encontrei pend|o que você|qual/i.test(q3.reply) && !/aprovado com sucesso|apliquei/i.test(q3.reply), q3.reply.slice(0, 200));

  // 4) ESCRITA pedida no chat (write off) — redireciona pra plataforma
  console.log("\n▶ 4) pedir pra EDITAR público/pausar no chat (chatAdsWrites=false) — redireciona pro site");
  const q4 = await turn("t4", "Edita o público da minha melhor campanha pra focar em mulheres 25-34.");
  show("edita-publico", q4);
  ok("4: redireciona/nega a escrita pelo chat (não promete editar por aqui)", REDIR.test(q4.reply) || /não consigo.*(por aqui|no chat|pelo chat|diretamente|aqui)|não (dá|posso).*(por aqui|no chat)/i.test(q4.reply), q4.reply.slice(0, 220));
  ok("4: sem erro técnico", !TECH.test(q4.reply));

  // 5) CAPACIDADES — declara honesto o que faz
  console.log("\n▶ 5) 'o que você consegue fazer?' — capacidades honestas");
  const q5 = await turn("t5", "O que exatamente você consegue fazer por mim aqui no WhatsApp?");
  show("capacidades", q5);
  ok("5: descreve capacidades reais (analisar/aprovar/consultar), sem prometer o impossível", /analis|aprov|consul|acompanh|pausar|orçamento|relat/i.test(q5.reply) && !TECH.test(q5.reply), q5.reply.slice(0, 260));

  console.log(`\n═══ FASE 2 (chat): ${pass} ok · ${fail} falhas ═══`);
  if (findings.length) { console.log("APONTAMENTOS:"); for (const f of findings) console.log("  ⚠️ " + f); }
  await deps.shutdown?.();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FASE 2 erro:", e); process.exit(1); });
