// Worker BullMQ da fila `whatsapp-inbound`: processa eventos do WhatsApp recebidos
// (a api valida o secret da instância e enfileira o payload CRU aqui).
// Roteamento (CLAUDE §8 — ban-safety):
//   1. CONNECTION_UPDATE → atualiza o status do canal (status ao vivo)
//   2. MESSAGES_UPSERT → resolve contato verificado → grava inbound → bufferiza +
//      agenda flush (debounce: coalesce mensagens picadas num turno só)
//   3. remetente DESCONHECIDO (não é contato verificado) → IGNORA em silêncio
// O turno do Grafo B roda no worker de FLUSH (whatsapp-flush.ts) — 1 job por conversa.

import { Queue, Worker } from "bullmq";
import {
  WHATSAPP_FLUSH_JOB,
  WHATSAPP_FLUSH_QUEUE,
  WHATSAPP_INBOUND_QUEUE,
  type WhatsappFlushPayload,
  type WhatsappInboundPayload,
} from "@trafego/shared";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "../composition.js";
import { pushInbound } from "../modules/conversation/buffer.js";
import { createNotifyRepo } from "../modules/notify/repo.js";

/** Margem sobre a janela de debounce p/ o TTL do buffer (nunca vaza chave). */
const BUFFER_TTL_MARGIN_SEC = 60;

export function startWebhookInboundWorker(deps: WorkerDeps, connection: Redis): Worker {
  const { ports, logger, redis } = deps;
  const repo = createNotifyRepo(deps.db);
  const flushQueue = new Queue(WHATSAPP_FLUSH_QUEUE, { connection });
  const debounceMs = deps.conversation.debounceSeconds * 1000;
  const bufferTtlSec = deps.conversation.debounceSeconds + BUFFER_TTL_MARGIN_SEC;

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

      // 2) mensagem: normaliza; null = ignorar (fromMe/ACK/grupo/sem conteúdo).
      const inbound = ports.messaging.parseInbound(raw);
      if (!inbound) {
        logger.debug({ jobId: job.id }, "inbound:ignored (unparseable)");
        return;
      }
      // Áudio/mídia-não-suportada: ramos entram na S5 (transcrição + aviso). Por ora só texto flui.
      if (inbound.kind !== "text") {
        logger.debug({ jobId: job.id, kind: inbound.kind }, "inbound:ignored (kind pendente)");
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

      // 6) bufferiza + (re)agenda o flush — debounce coalesce mensagens picadas.
      await pushInbound(redis, conversationId, inbound.text, bufferTtlSec);
      const payload: WhatsappFlushPayload = { orgId: contact.orgId, contactId: contact.contactId, conversationId };
      await flushQueue.remove(conversationId).catch(() => {}); // reinicia a janela
      await flushQueue.add(WHATSAPP_FLUSH_JOB, payload, {
        jobId: conversationId,
        delay: debounceMs,
        removeOnComplete: true,
        removeOnFail: true,
      });
      logger.debug({ conversationId }, "inbound:buffered");
    },
    { connection },
  );
}
