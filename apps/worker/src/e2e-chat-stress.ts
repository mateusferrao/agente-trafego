// E2E LIVE — stress de fraseados no chat (LLM real, grafo direto, agente EM FOCO).
// Sem escrita na Meta (só propostas/rascunho local). Reverte os drafts criados no fim.
// npx tsx --env-file=/c/dev/agente-trafego/.env src/e2e-chat-stress.ts
import { randomUUID } from "node:crypto";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { buildComposition } from "./composition.js";
import { buildWhatsappConversationGraph } from "./graphs/whatsapp-conversation/graph.js";
import { AGENT_TOOL_NAMES, CREATE_TOOL_NAMES, REFINE_TOOL_NAMES, WRITE_TOOL_NAMES, CONFIG_CHAT_TOOL_NAMES, type ConversationToolContext } from "./graphs/whatsapp-conversation/tools.js";
import { approvals, campaignDrafts } from "@trafego/db";
import { and, eq, inArray } from "drizzle-orm";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const AGENT = "f1452a45-84d9-478e-8f39-62e55fcf2be5";
const ACCT = "d246db5c-d843-4519-a588-9197131458c4";
const L = (s = "") => console.log(s);
function lastText(m: BaseMessage[]): string {
  const ai = [...m].reverse().find((x) => (x as { _getType?: () => string })._getType?.() === "ai");
  const c = ai?.content ?? m.at(-1)?.content ?? "";
  return typeof c === "string" ? c : JSON.stringify(c);
}

const deps = await buildComposition();
let failed = false;
try {
  const ctx: ConversationToolContext = {
    orgId: ORG, agentId: AGENT, adAccountId: ACCT, timezone: "America/Sao_Paulo",
    ref: { kind: "contact", contactId: "e2e" }, conversationId: randomUUID(), multiAccount: false, configViaChat: true,
  };
  const allow = new Set<string>([...AGENT_TOOL_NAMES, ...WRITE_TOOL_NAMES, ...CREATE_TOOL_NAMES, ...REFINE_TOOL_NAMES, ...CONFIG_CHAT_TOOL_NAMES]);
  const graph = buildWhatsappConversationGraph(deps, ctx, allow);
  const ask = async (text: string, thread: string): Promise<string> => {
    const out = (await graph.invoke({ messages: [new HumanMessage(text)], orgId: ORG, agentId: AGENT, adAccountId: ACCT }, { configurable: { thread_id: thread } })) as { messages: BaseMessage[] };
    return lastText(out.messages);
  };
  const turn = async (label: string, text: string, thread: string) => {
    L(`\n👤 [${label}] ${text}`);
    try { L(`🤖 ${await ask(text, thread)}`); } catch (e) { L(`❌ ERRO NÃO TRATADO: ${e instanceof Error ? e.message : String(e)}`); failed = true; }
  };

  L("═══ STRESS de fraseados (LLM real, agente em foco: BM Automato) ═══");

  // A. cópia multi-turn trocando N coisas (budget → ativação)
  const t1 = randomUUID();
  await turn("copy", "copia a campanha CaquiAI lead pra remarketing usando um público de instagram que interagiu, e exclui quem visitou o site", t1);
  await turn("copy+budget", "muda o orçamento dessa cópia pra R$80 por dia", t1);
  await turn("copy+ativar", "e já deixa pronta pra ativar", t1);

  // B. troca de objetivo divergente → para e explica
  await turn("obj-divergente", "copia a campanha CaquiAI lead mas como campanha de vendas", randomUUID());

  // C. públicos — quais posso usar
  await turn("publicos", "quais públicos eu posso usar pra fazer remarketing?", randomUUID());

  // D. criar do zero com público específico (create_campaign NÃO aceita público hoje — ver honestidade)
  await turn("cria+publico", "cria uma campanha de leads nova com uns R$60 por dia mirando o público de quem interagiu no instagram", randomUUID());

  // E. número de WhatsApp de campanha específica
  await turn("whatsapp-especifico", "qual o número de whatsapp da campanha [01][ABO][Leads][Advtg][Whatsapp]?", randomUUID());

  // F. ambiguidade (2 campanhas 'E2E Fatia7 — Criacao')
  await turn("ambiguo", "copia a campanha E2E Fatia7", randomUUID());

  // G. campanha inexistente → erro amigável
  await turn("inexistente", "copia a campanha Promoção Dia das Mães que não existe", randomUUID());

  // H. público inexistente → honesto
  await turn("publico-inexistente", "cria uma campanha usando o público 'Clientes VIP Ouro' e me diz se existe", randomUUID());

  // I. copiar preservando tudo (sem troca) — só mudar budget
  await turn("copy-fiel-simples", "faz uma cópia idêntica da CaquiAI lead só que com R$30 por dia", randomUUID());

  L("\n✅ Stress concluído");
} catch (e) {
  failed = true;
  L(`\n❌ ERRO GERAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
} finally {
  // REVERT: apaga os rascunhos criados no stress (nenhuma escrita na Meta ocorreu)
  try {
    const drafts = await deps.db.select({ id: campaignDrafts.id }).from(campaignDrafts).where(eq(campaignDrafts.agentId, AGENT));
    const ids = drafts.map((d) => d.id);
    if (ids.length > 0) await deps.db.delete(approvals).where(and(eq(approvals.agentId, AGENT), inArray(approvals.draftId, ids)));
    const dels = await deps.db.delete(campaignDrafts).where(eq(campaignDrafts.agentId, AGENT)).returning({ id: campaignDrafts.id });
    L(`\n🧹 REVERT: ${dels.length} rascunho(s) + aprovações apagados do banco local`);
  } catch (e) {
    L(`⚠️ revert de drafts falhou: ${String(e)}`);
  }
  await deps.redis.quit().catch(() => {});
  await deps.db.$client?.end?.().catch(() => {});
  process.exit(failed ? 1 : 0);
}
