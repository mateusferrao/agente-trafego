// Um turno do chat do WhatsApp (Grafo B): resolve o agente em contexto (1 ativo →
// conta; N/0 → concierge), roda o ReAct (checkpointer por conversa) e responde via
// sendToContact. Reusado pelo flush do debounce (5b-2.4). Erro → resposta amigável.

import { and, eq } from "drizzle-orm";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import { adAccounts, agents, type Database } from "@trafego/db";
import type { WorkerDeps } from "../../composition.js";
import { buildWhatsappConversationGraph } from "../../graphs/whatsapp-conversation/graph.js";
import {
  AGENT_TOOL_NAMES,
  CONCIERGE_TOOL_NAMES,
  type ConversationToolContext,
} from "../../graphs/whatsapp-conversation/tools.js";
import { createNotifyRepo } from "../notify/repo.js";
import { createSendToContact } from "../notify/send-to-contact.js";

/** Erro amigável se o turno falhar (LLM/infra) — nunca vaza stack pro usuário (§UX). */
const FALLBACK_REPLY = "Não consegui processar agora. Tenta de novo em instantes.";

/** Agente/conta em contexto quando a org tem EXATAMENTE 1 agente ativo; senão null (concierge). */
async function resolveSoleAgent(
  db: Database,
  orgId: string,
): Promise<{ agentId: string; adAccountId: string } | null> {
  const rows = await db
    .select({ agentId: agents.id, adAccountId: agents.adAccountId })
    .from(agents)
    .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
    .where(and(eq(agents.orgId, orgId), eq(agents.status, "active"), eq(adAccounts.status, "active")))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

export interface ConversationTurnInput {
  readonly orgId: string;
  readonly contactId: string;
  readonly conversationId: string;
  /** texto do turno (uma ou mais mensagens coalescidas pelo debounce). */
  readonly text: string;
}

/** Roda o Grafo B para um turno e empurra a resposta na conversa. */
export async function runConversationTurn(deps: WorkerDeps, input: ConversationTurnInput): Promise<void> {
  const { logger, ports } = deps;
  const sendToContact = createSendToContact({ messaging: ports.messaging, repo: createNotifyRepo(deps.db) });

  const sole = await resolveSoleAgent(deps.db, input.orgId);
  const ctx: ConversationToolContext = {
    orgId: input.orgId,
    agentId: sole?.agentId ?? "",
    adAccountId: sole?.adAccountId ?? "",
    contactId: input.contactId,
    conversationId: input.conversationId,
  };
  const allow = sole ? AGENT_TOOL_NAMES : CONCIERGE_TOOL_NAMES;

  let reply = FALLBACK_REPLY;
  try {
    const graph = buildWhatsappConversationGraph(deps, ctx, allow);
    const result = await graph.invoke(
      {
        messages: [new HumanMessage(input.text)],
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        adAccountId: ctx.adAccountId,
        contactId: ctx.contactId,
      },
      { configurable: { thread_id: input.conversationId } },
    );
    const last = result.messages.at(-1) as AIMessage | undefined;
    const text = typeof last?.content === "string" ? last.content.trim() : "";
    if (text.length > 0) reply = text;
  } catch (err) {
    logger.error({ err, orgId: input.orgId }, "conversation:turn falhou");
  }

  await sendToContact(input.contactId, reply, { split: true });
  logger.info({ orgId: input.orgId }, "conversation:replied");
}
