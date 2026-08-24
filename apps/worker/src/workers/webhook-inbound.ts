// Worker BullMQ da fila `whatsapp-inbound`: processa eventos do WhatsApp recebidos
// (a api valida o secret da instância e enfileira o payload CRU aqui).
// Roteamento (CLAUDE §8/§9 — ban-safety):
//   1. CONNECTION_UPDATE → atualiza o status do canal (status ao vivo)
//   2. MESSAGES_UPSERT:
//      • DM: só contato VERIFICADO (desconhecido → silêncio). Dedupe → por tipo
//        (texto/áudio/mídia-não-suportada), igual sempre.
//      • GRUPO: grupo precisa estar REGISTRADO+ativo (não-registrado → silêncio).
//        SEM verificação de membro (a adesão ao grupo é a fronteira — §9). Só
//        processa se DIRIGIDO ao bot (@menção OU reply a msg do bot); não-dirigido
//        → ignora e NÃO persiste (default) OU vira contexto se `groupIngestContext`.
// O turno do Grafo B roda no worker de FLUSH (whatsapp-flush.ts) — 1 job por conversa.

import { Queue, Worker } from "bullmq";
import {
  WHATSAPP_FLUSH_QUEUE,
  WHATSAPP_INBOUND_QUEUE,
  WHATSAPP_TRANSCRIPTION_ATTEMPTS,
  WHATSAPP_TRANSCRIPTION_BACKOFF_MS,
  WHATSAPP_TRANSCRIPTION_JOB,
  WHATSAPP_TRANSCRIPTION_QUEUE,
  type ConversationRef,
  type WhatsappFlushPayload,
  type WhatsappInboundPayload,
  type WhatsappTranscriptionPayload,
} from "@trafego/shared";
import type { InboundMessage } from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { WorkerDeps } from "../composition.js";
import { isAddressedToBot } from "../modules/conversation/addressing.js";
import { BUFFER_TTL_MARGIN_SEC, pushInbound } from "../modules/conversation/buffer.js";
import { markTranscribing, scheduleConversationFlush } from "../modules/conversation/flush-control.js";
import { sendCourtesyNotice } from "../modules/conversation/courtesy-notice.js";
import { unsupportedMediaNotice } from "../modules/conversation/notices.js";
import { createNotifyRepo, type NotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation, type SendToConversation } from "../modules/notify/send-to-contact.js";

/** Balde de throttle do aviso de mídia não-suportada (separado do de áudio). */
const UNSUPPORTED_NOTICE_BUCKET = "unsupported";

/** Dependências do router de mensagem inbound (enxutas → testável sem BullMQ). */
export interface InboundRouterDeps {
  readonly repo: Pick<
    NotifyRepo,
    "resolveInboundContact" | "alreadyProcessed" | "ensureConversation" | "recordMessage" | "instancePhone" | "resolveInboundGroup" | "ensureGroupConversation"
  >;
  readonly redis: Redis;
  readonly flushQueue: Pick<Queue<WhatsappFlushPayload>, "add" | "remove">;
  readonly transcriptionQueue: Pick<Queue<WhatsappTranscriptionPayload>, "add">;
  readonly sendToConversation: SendToConversation;
  readonly logger: Pick<Logger, "debug">;
  readonly debounceMs: number;
  readonly bufferTtlSec: number;
  readonly transcribingTtlSec: number;
  readonly throttleSec: number;
  /** Grupo: mensagem não-dirigida vira contexto persistido em vez de ser ignorada. */
  readonly groupIngestContext: boolean;
}

/** Enfileira/agenda o pipeline comum a DM e grupo (texto/áudio/não-suportada), já com
 *  a `ref` e `conversationId` resolvidos — o resto do fluxo não sabe mais se é DM ou grupo. */
async function routeMessage(
  d: InboundRouterDeps,
  instanceId: string,
  inbound: InboundMessage,
  orgId: string,
  conversationId: string,
  ref: ConversationRef,
): Promise<void> {
  const flushPayload: WhatsappFlushPayload = { orgId, conversationId, ref };

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
      orgId,
      ref,
      conversationId,
      messageRowId,
      instanceId,
      audio: { ...inbound.audio, messageKey: inbound.messageKey },
    };
    await d.transcriptionQueue.add(WHATSAPP_TRANSCRIPTION_JOB, payload, {
      attempts: WHATSAPP_TRANSCRIPTION_ATTEMPTS,
      backoff: { type: "exponential", delay: WHATSAPP_TRANSCRIPTION_BACKOFF_MS },
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
  await sendCourtesyNotice(d.redis, d.sendToConversation, {
    conversationId,
    ref,
    text: unsupportedMediaNotice(inbound.mediaType),
    bucket: UNSUPPORTED_NOTICE_BUCKET,
    throttleSec: d.throttleSec,
  });
  d.logger.debug({ conversationId, mediaType: inbound.mediaType }, "inbound:unsupported_media");
}

/**
 * Roteia uma mensagem de GRUPO: grupo precisa estar registrado+ativo (senão silêncio).
 * SEM verificação de membro (§9 — a adesão ao grupo é a fronteira). Só processa se
 * DIRIGIDA ao bot (@menção OU reply à msg do bot); não-dirigida → ignora e não
 * persiste (default) ou vira contexto (env `groupIngestContext`, texto apenas).
 */
async function routeGroupMessage(d: InboundRouterDeps, instanceId: string, inbound: InboundMessage): Promise<void> {
  const group = inbound.group;
  if (!group) return; // guard de tipo (chamador já garantiu)

  const resolved = await d.repo.resolveInboundGroup(instanceId, group.groupJid);
  if (!resolved) {
    d.logger.debug({ instanceId }, "inbound:ignored (group not registered)");
    return;
  }
  if (await d.repo.alreadyProcessed(inbound.messageId)) {
    d.logger.debug({ messageId: inbound.messageId }, "inbound:duplicate");
    return;
  }

  const botPhone = await d.repo.instancePhone(instanceId);
  const addressed = isAddressedToBot(group, botPhone);
  if (!addressed) {
    if (d.groupIngestContext && inbound.kind === "text") {
      const conversationId = await d.repo.ensureGroupConversation(resolved.orgId, resolved.groupId, group.senderPhone);
      await d.repo.recordMessage(conversationId, "inbound", inbound.text, { messageId: inbound.messageId, context: true });
    }
    // diagnóstico: compara o que o parser extraiu da menção/reply contra o telefone do
    // bot — suspeita de @lid (WhatsApp endereça contato não-salvo por id interno, não
    // telefone) precisa VER os valores reais, não só saber que não bateu.
    d.logger.debug(
      { instanceId, botPhone, mentionedPhones: group.mentionedPhones, quotedAuthorPhone: group.quotedAuthorPhone },
      "inbound:group_not_addressed",
    );
    return;
  }

  const conversationId = await d.repo.ensureGroupConversation(resolved.orgId, resolved.groupId, group.senderPhone);
  const ref: ConversationRef = { kind: "group", groupId: resolved.groupId, participantPhone: group.senderPhone };
  await routeMessage(d, instanceId, inbound, resolved.orgId, conversationId, ref);
}

/**
 * Roteia uma mensagem inbound JÁ normalizada: DM (contato verificado + dedupe) ou
 * GRUPO (registrado + dirigido), depois ramifica por tipo (texto/áudio/mídia-não-
 * suportada). Puro de BullMQ (queues/redis injetados) → testável com fakes.
 */
export function makeInboundRouter(d: InboundRouterDeps) {
  return async function route(instanceId: string, inbound: InboundMessage): Promise<void> {
    if (inbound.group) return routeGroupMessage(d, instanceId, inbound);

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
    const ref: ConversationRef = { kind: "contact", contactId: contact.contactId };
    await routeMessage(d, instanceId, inbound, contact.orgId, conversationId, ref);
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
    sendToConversation: createSendToConversation({ messaging: ports.messaging, repo }),
    logger,
    debounceMs: deps.conversation.debounceSeconds * 1000,
    bufferTtlSec: deps.conversation.debounceSeconds + BUFFER_TTL_MARGIN_SEC,
    transcribingTtlSec: deps.transcription.transcribingTtlSec, // backstop: flag expira → flush destrava
    throttleSec: deps.conversation.noticeThrottleSec,
    groupIngestContext: deps.conversation.groupIngestContext,
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
