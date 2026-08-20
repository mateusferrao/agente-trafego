// Worker BullMQ da fila `whatsapp-inbound`: processa eventos do WhatsApp recebidos
// (a api valida o secret da instância e enfileira o payload CRU aqui).
// Roteamento (CLAUDE §8 — ban-safety):
//   1. CONNECTION_UPDATE → atualiza o status do canal (status ao vivo)
//   2. MESSAGES_UPSERT → resolve contato verificado → grava inbound → Grafo B → responde
//   3. remetente DESCONHECIDO (não é contato verificado) → IGNORA em silêncio
// Concorrência 1 (default BullMQ) serializa os turnos por conversa (sem corrida no
// checkpointer). Debounce (coalescer picadas) = próxima peça da 5b-2.2.

import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import { adAccounts, agents, type Database } from "@trafego/db";
import { WHATSAPP_INBOUND_QUEUE, type WhatsappInboundPayload } from "@trafego/shared";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "../composition.js";
import { buildWhatsappConversationGraph } from "../graphs/whatsapp-conversation/graph.js";
import { CONCIERGE_TOOL_NAMES, READ_TOOL_NAMES, type ConversationToolContext } from "../graphs/whatsapp-conversation/tools.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToContact } from "../modules/notify/send-to-contact.js";

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

export function startWebhookInboundWorker(deps: WorkerDeps, connection: Redis): Worker {
  const { ports, logger } = deps;
  const repo = createNotifyRepo(deps.db);
  const sendToContact = createSendToContact({ messaging: ports.messaging, repo });

  return new Worker<WhatsappInboundPayload>(
    WHATSAPP_INBOUND_QUEUE,
    async (job) => {
      const { instanceId, raw } = job.data;

      // 1) mudança de conexão → status ao vivo (sem contato/mensagem).
      const status = ports.messaging.parseConnectionUpdate(raw);
      if (status) {
        await repo.updateInstanceStatus(instanceId, status);
        logger.debug({ instanceId, status }, "inbound:connection_update");
        return;
      }

      // 2) mensagem: normaliza; null = ignorar (fromMe/ACK/grupo/não-texto).
      const inbound = ports.messaging.parseInbound(raw);
      if (!inbound) {
        logger.debug({ jobId: job.id }, "inbound:ignored (unparseable)");
        return;
      }

      // 3) só contato VERIFICADO da org dona da instância — desconhecido = silêncio (§8).
      const contact = await repo.resolveInboundContact(instanceId, inbound.from);
      if (!contact) {
        logger.debug({ instanceId }, "inbound:ignored (unknown sender)");
        return;
      }

      // 4) idempotência do provider (webhook pode reentregar).
      if (await repo.alreadyProcessed(inbound.messageId)) {
        logger.debug({ messageId: inbound.messageId }, "inbound:duplicate");
        return;
      }

      // 5) grava o inbound + resolve a conversa (thread do checkpointer).
      const conversationId = await repo.ensureConversation(contact.orgId, contact.contactId);
      await repo.recordMessage(conversationId, "inbound", inbound.text, { messageId: inbound.messageId });

      // 6) contexto: 1 agente ativo → conta em contexto; N/0 → concierge (só org-level).
      const sole = await resolveSoleAgent(deps.db, contact.orgId);
      const ctx: ConversationToolContext = {
        orgId: contact.orgId,
        agentId: sole?.agentId ?? "",
        adAccountId: sole?.adAccountId ?? "",
        contactId: contact.contactId,
        conversationId,
      };
      const allow = sole ? READ_TOOL_NAMES : CONCIERGE_TOOL_NAMES;

      // 7) roda o Grafo B (ReAct + checkpointer por thread) e responde.
      let reply = FALLBACK_REPLY;
      try {
        const graph = buildWhatsappConversationGraph(deps, ctx, allow);
        const result = await graph.invoke(
          {
            messages: [new HumanMessage(inbound.text)],
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            adAccountId: ctx.adAccountId,
            contactId: ctx.contactId,
          },
          { configurable: { thread_id: conversationId } },
        );
        const last = result.messages.at(-1) as AIMessage | undefined;
        const text = typeof last?.content === "string" ? last.content.trim() : "";
        if (text.length > 0) reply = text;
      } catch (err) {
        logger.error({ err, orgId: contact.orgId }, "inbound:grafo B falhou");
      }

      await sendToContact(contact.contactId, reply, { split: true });
      logger.info({ orgId: contact.orgId }, "inbound:replied");
    },
    { connection },
  );
}
