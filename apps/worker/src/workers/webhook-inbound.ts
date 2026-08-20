// Worker BullMQ da fila `whatsapp-inbound`: processa eventos do WhatsApp recebidos
// (a api valida o secret da instância e enfileira o payload CRU aqui).
// Roteamento (CLAUDE §8 — ban-safety):
//   1. CONNECTION_UPDATE → atualiza o status do canal (status ao vivo)
//   2. MESSAGES_UPSERT → resolve contato verificado → grava inbound → responde
//   3. remetente DESCONHECIDO (não é contato verificado) → IGNORA em silêncio
// Grafo B (ReAct + leitura/aprovação) entra na 5b-2.2 — por ora responde um ack.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { WHATSAPP_INBOUND_QUEUE, type WhatsappInboundPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToContact } from "../modules/notify/send-to-contact.js";

/** Ack provisório (5b-2.1) — substituído pelo Grafo B (leitura/aprovação) na 5b-2.2. */
const ACK_TEXT =
  "Oi! 👋 Sou o agente da sua conta de anúncios. Em breve vou poder conversar por aqui — " +
  "te dar o status, rodar uma análise e resolver aprovações.";

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

      // 5) grava a mensagem inbound na conversa.
      const conversationId = await repo.ensureConversation(contact.orgId, contact.contactId);
      await repo.recordMessage(conversationId, "inbound", inbound.text, { messageId: inbound.messageId });

      // 6) responde (ack provisório → Grafo B na 5b-2.2).
      await sendToContact(contact.contactId, ACK_TEXT, { split: true });
      logger.info({ orgId: contact.orgId }, "inbound:acked");
    },
    { connection },
  );
}
