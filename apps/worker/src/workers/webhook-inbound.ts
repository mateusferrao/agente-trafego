// Worker BullMQ da fila `whatsapp-inbound`: processa eventos do WhatsApp recebidos
// (a api valida o secret da instância e enfileira o payload CRU aqui).
// Roteamento (CLAUDE §8 — ban-safety):
//   1. CONNECTION_UPDATE → atualiza o status do canal (status ao vivo)
//   2. MESSAGES_UPSERT (contato VERIFICADO, dedupe) → por tipo:
//        • texto → bufferiza + agenda flush (debounce: coalesce picadas)
//        • áudio → grava, marca `wa:transcribing` (segura o flush), enfileira transcrição
//        • mídia não-suportada → aviso amigável throttled (não drop em silêncio)
//   3. remetente DESCONHECIDO → IGNORA em silêncio
// O turno do Grafo B roda no worker de FLUSH (whatsapp-flush.ts) — 1 job por conversa.

import { Queue, Worker } from "bullmq";
import {
  WHATSAPP_FLUSH_QUEUE,
  WHATSAPP_INBOUND_QUEUE,
  WHATSAPP_TRANSCRIPTION_JOB,
  WHATSAPP_TRANSCRIPTION_QUEUE,
  type WhatsappFlushPayload,
  type WhatsappInboundPayload,
  type WhatsappTranscriptionPayload,
} from "@trafego/shared";
import type { InboundMessage } from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { WorkerDeps } from "../composition.js";
import { BUFFER_TTL_MARGIN_SEC, pushInbound } from "../modules/conversation/buffer.js";
import { markTranscribing, scheduleConversationFlush } from "../modules/conversation/flush-control.js";
import { sendCourtesyNotice } from "../modules/conversation/courtesy-notice.js";
import { unsupportedMediaNotice } from "../modules/conversation/notices.js";
import { createNotifyRepo, type NotifyRepo } from "../modules/notify/repo.js";
import { createSendToContact, type SendToContact } from "../modules/notify/send-to-contact.js";

/** Retentativas da transcrição (só erros transitórios re-tentam — ver worker). */
const TRANSCRIPTION_ATTEMPTS = 3;
const TRANSCRIPTION_BACKOFF_MS = 3_000;

/** Dependências do router de mensagem inbound (enxutas → testável sem BullMQ). */
export interface InboundRouterDeps {
  readonly repo: Pick<NotifyRepo, "resolveInboundContact" | "alreadyProcessed" | "ensureConversation" | "recordMessage">;
  readonly redis: Redis;
  readonly flushQueue: Pick<Queue<WhatsappFlushPayload>, "add" | "remove">;
  readonly transcriptionQueue: Pick<Queue<WhatsappTranscriptionPayload>, "add">;
  readonly sendToContact: SendToContact;
  readonly logger: Pick<Logger, "debug">;
  readonly debounceMs: number;
  readonly bufferTtlSec: number;
  readonly transcribingTtlSec: number;
  readonly throttleSec: number;
}

/**
 * Roteia uma mensagem inbound JÁ normalizada: contato verificado + dedupe, depois
 * ramifica por tipo (texto/áudio/mídia-não-suportada). Puro de BullMQ (queues/redis
 * injetados) → testável com fakes.
 */
export function makeInboundRouter(d: InboundRouterDeps) {
  return async function route(instanceId: string, inbound: InboundMessage): Promise<void> {
    // só contato VERIFICADO da org dona da instância — desconhecido = silêncio (§8).
    const contact = await d.repo.resolveInboundContact(instanceId, inbound.from);
    if (!contact) {
      d.logger.debug({ instanceId }, "inbound:ignored (unknown sender)");
      return;
    }
    // idempotência do provider (webhook pode reentregar).
    if (await d.repo.alreadyProcessed(inbound.messageId)) {
      d.logger.debug({ messageId: inbound.messageId }, "inbound:duplicate");
      return;
    }

    const conversationId = await d.repo.ensureConversation(contact.orgId, contact.contactId);
    const flushPayload: WhatsappFlushPayload = { orgId: contact.orgId, contactId: contact.contactId, conversationId };

    if (inbound.kind === "text") {
      await d.repo.recordMessage(conversationId, "inbound", inbound.text, { messageId: inbound.messageId });
      await pushInbound(d.redis, conversationId, inbound.text, d.bufferTtlSec);
      await scheduleConversationFlush(d.flushQueue, flushPayload, d.debounceMs);
      d.logger.debug({ conversationId }, "inbound:buffered");
      return;
    }

    if (inbound.kind === "audio") {
      const messageRowId = await d.repo.recordMessage(conversationId, "inbound", null, {
        messageId: inbound.messageId,
        kind: "audio",
        transcribing: true,
      });
      await markTranscribing(d.redis, conversationId, d.transcribingTtlSec); // segura o flush
      const payload: WhatsappTranscriptionPayload = {
        orgId: contact.orgId,
        contactId: contact.contactId,
        conversationId,
        messageRowId,
        audio: inbound.audio,
      };
      await d.transcriptionQueue.add(WHATSAPP_TRANSCRIPTION_JOB, payload, {
        attempts: TRANSCRIPTION_ATTEMPTS,
        backoff: { type: "exponential", delay: TRANSCRIPTION_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: true,
      });
      // agenda o flush: ele vai ESPERAR a flag até a transcrição terminar (settle re-agenda).
      await scheduleConversationFlush(d.flushQueue, flushPayload, d.debounceMs);
      d.logger.debug({ conversationId }, "inbound:audio_enqueued");
      return;
    }

    // mídia reconhecida mas não-suportada → aviso amigável throttled (nunca silêncio).
    await d.repo.recordMessage(conversationId, "inbound", null, {
      messageId: inbound.messageId,
      kind: "unsupported",
      mediaType: inbound.mediaType,
    });
    await sendCourtesyNotice(d.redis, d.sendToContact, {
      conversationId,
      contactId: contact.contactId,
      text: unsupportedMediaNotice(inbound.mediaType),
      throttleSec: d.throttleSec,
    });
    d.logger.debug({ conversationId, mediaType: inbound.mediaType }, "inbound:unsupported_media");
  };
}

/** Start do worker BullMQ (composition injeta deps; connection = conexão dos Workers). */
export function startWebhookInboundWorker(deps: WorkerDeps, connection: Redis): Worker {
  const { ports, logger, redis } = deps;
  const repo = createNotifyRepo(deps.db);
  const flushQueue = new Queue<WhatsappFlushPayload>(WHATSAPP_FLUSH_QUEUE, { connection });
  const transcriptionQueue = new Queue<WhatsappTranscriptionPayload>(WHATSAPP_TRANSCRIPTION_QUEUE, { connection });
  const route = makeInboundRouter({
    repo,
    redis,
    flushQueue,
    transcriptionQueue,
    sendToContact: createSendToContact({ messaging: ports.messaging, repo }),
    logger,
    debounceMs: deps.conversation.debounceSeconds * 1000,
    bufferTtlSec: deps.conversation.debounceSeconds + BUFFER_TTL_MARGIN_SEC,
    // TTL-backstop da flag: cobre todas as tentativas + margem (job sumiu → flag expira → flush destrava).
    transcribingTtlSec:
      Math.ceil((deps.transcription.timeoutMs / 1000) * TRANSCRIPTION_ATTEMPTS) + BUFFER_TTL_MARGIN_SEC,
    throttleSec: deps.conversation.debounceSeconds,
  });

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

      // 2) mensagem: normaliza; null = ignorar (fromMe/ACK/grupo/sem conteúdo) → roteia.
      const inbound = ports.messaging.parseInbound(raw);
      if (!inbound) {
        logger.debug({ jobId: job.id }, "inbound:ignored (unparseable)");
        return;
      }
      await route(instanceId, inbound);
    },
    { connection },
  );
}
