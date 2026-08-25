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
//        → vira CONTEXTO ambiente (group_messages, sem turno) quando `groupIngestContext`
//        (kill-switch de plataforma, default ON); senão, ignora em silêncio.
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
import type { InboundMessage, MessagingChannelPort } from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { WorkerDeps } from "../composition.js";
import { isAddressedToBot } from "../modules/conversation/addressing.js";
import { BUFFER_TTL_MARGIN_SEC, pushInbound } from "../modules/conversation/buffer.js";
import { markTranscribing, scheduleConversationFlush } from "../modules/conversation/flush-control.js";
import { sendCourtesyNotice } from "../modules/conversation/courtesy-notice.js";
import { loadGroupParticipantsMap } from "../modules/conversation/group-participants-cache.js";
import { QUOTED_AUTHOR_FALLBACK_LABEL, unsupportedMediaNotice } from "../modules/conversation/notices.js";
import { participantLabelFromPhone } from "@trafego/core";
import { createNotifyRepo, type NotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation, type SendToConversation } from "../modules/notify/send-to-contact.js";

/** Balde de throttle do aviso de mídia não-suportada (separado do de áudio). */
const UNSUPPORTED_NOTICE_BUCKET = "unsupported";

/** Placeholder de mídia no contexto ambiente de grupo (não transcreve; dá continuidade). */
const AMBIENT_AUDIO_PLACEHOLDER = "[áudio]";
const AMBIENT_MEDIA_PLACEHOLDER: Readonly<Record<string, string>> = { image: "[imagem]" };
const AMBIENT_MEDIA_DEFAULT = "[mídia]";

/** Corpo a guardar de uma mensagem AMBIENTE de grupo: texto cru ou placeholder de mídia. */
function ambientBody(inbound: InboundMessage): string {
  if (inbound.kind === "text") return inbound.text;
  if (inbound.kind === "audio") return AMBIENT_AUDIO_PLACEHOLDER;
  return AMBIENT_MEDIA_PLACEHOLDER[inbound.mediaType] ?? AMBIENT_MEDIA_DEFAULT;
}

/** Trecho da mensagem CITADA p/ o transcript ("em resposta a X: ..."): texto ou placeholder de mídia. */
function quotedSnippetDisplay(group: NonNullable<InboundMessage["group"]>): string | null {
  if (group.quotedSnippet) return group.quotedSnippet;
  if (group.quotedKind === "audio") return AMBIENT_AUDIO_PLACEHOLDER;
  if (group.quotedKind === "image") return AMBIENT_MEDIA_PLACEHOLDER["image"] ?? AMBIENT_MEDIA_DEFAULT;
  if (group.quotedKind === "media") return AMBIENT_MEDIA_DEFAULT;
  return null;
}

/** Dependências do router de mensagem inbound (enxutas → testável sem BullMQ). */
export interface InboundRouterDeps {
  readonly repo: Pick<
    NotifyRepo,
    | "resolveInboundContact"
    | "alreadyProcessed"
    | "ensureConversation"
    | "recordMessage"
    | "recordGroupMessage"
    | "instancePhone"
    | "resolveInboundGroup"
    | "ensureGroupConversation"
  >;
  readonly messaging: Pick<MessagingChannelPort, "resolveGroupParticipants">;
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
  /** TTL (s) do cache do mapa LID→telefone dos participantes do grupo. */
  readonly groupParticipantsCacheTtlSec: number;
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
  /** meta extra p/ atribuição no transcript de grupo (authorName do remetente). */
  extraMeta: Record<string, unknown> = {},
): Promise<void> {
  const flushPayload: WhatsappFlushPayload = { orgId, conversationId, ref };

  if (inbound.kind === "text") {
    await d.repo.recordMessage(conversationId, "inbound", inbound.text, { messageId: inbound.messageId, ...extraMeta });
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
      ...extraMeta,
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
    ...extraMeta,
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
 * SEM verificação de membro (§9 — a adesão ao grupo é a fronteira). Só processa (turno) se
 * DIRIGIDA ao bot (@menção OU reply à msg do bot); não-dirigida → vira CONTEXTO ambiente em
 * group_messages (texto/placeholder de mídia, sem turno) quando `groupIngestContext` (default
 * ON); senão, ignora em silêncio.
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
  let addressed = isAddressedToBot(group, botPhone);
  // Telefone EFETIVO do autor citado: em grupo migrado (LID) o telefone de terceiros só
  // aparece após resolver o LID — sem isso, downstream (quotedFromBot / rótulo do citado)
  // leria `group.quotedAuthorPhone` stale (null) e perderia a atribuição do reply.
  let quotedAuthorPhone = group.quotedAuthorPhone;

  // Menção/reply só por LID (grupo migrado, addressingMode "lid"): o telefone de
  // terceiros não vem no payload da mensagem (só o do remetente). Resolve via cache
  // (Evolution group/fetchAllGroups?getParticipants=true) só quando precisa — a
  // maioria das mensagens de grupo não tem menção nenhuma, não vale bater na API à toa.
  if (!addressed && botPhone && (group.mentionedLids.length > 0 || group.quotedAuthorLid)) {
    const lidMap = await loadGroupParticipantsMap(
      { redis: d.redis, messaging: d.messaging, ttlSec: d.groupParticipantsCacheTtlSec },
      { instanceId },
      group.groupJid,
    );
    const mentionedPhones = [...group.mentionedPhones, ...group.mentionedLids.map((lid) => lidMap[lid]).filter((p): p is string => p !== undefined)];
    quotedAuthorPhone = group.quotedAuthorPhone ?? (group.quotedAuthorLid ? (lidMap[group.quotedAuthorLid] ?? null) : null);
    addressed = isAddressedToBot({ mentionedPhones, quotedAuthorPhone }, botPhone);
  }

  if (!addressed) {
    // Contexto ambiente: guarda a mensagem alheia em group_messages (SEM fabricar conversa
    // nem disparar turno) p/ o transcript read-only injetado quando o bot for dirigido.
    // Idempotente por (grupo, messageId). Kill-switch de plataforma via groupIngestContext.
    if (d.groupIngestContext) {
      await d.repo.recordGroupMessage({
        orgId: resolved.orgId,
        groupId: resolved.groupId,
        authorPhone: group.senderPhone,
        authorName: group.senderName,
        body: ambientBody(inbound),
        messageId: inbound.messageId,
        quotedAuthorPhone,
        quotedSnippet: quotedSnippetDisplay(group),
      });
    }
    d.logger.debug({ instanceId }, "inbound:group_not_addressed");
    return;
  }

  const conversationId = await d.repo.ensureGroupConversation(resolved.orgId, resolved.groupId, group.senderPhone);
  const ref: ConversationRef = { kind: "group", groupId: resolved.groupId, participantPhone: group.senderPhone };

  // (b) reply a um ÁUDIO marcando o bot: transcreve o áudio CITADO e prefixa no turno,
  // junto do texto que o usuário digitou. O áudio citado é buscado por chave (fetchMediaBase64).
  if (inbound.kind === "text" && group.quotedKind === "audio" && group.quotedStanzaId) {
    // O bot nunca envia áudio → uma citação de áudio jamais é do próprio bot (sem quotedFromBot).
    await d.repo.recordMessage(conversationId, "inbound", inbound.text, {
      messageId: inbound.messageId,
      authorName: group.senderName,
      ...(quotedAuthorPhone ? { quotedAuthorPhone } : {}),
      quotedSnippet: AMBIENT_AUDIO_PLACEHOLDER,
    });
    const authorLabel = participantLabelFromPhone(quotedAuthorPhone) ?? QUOTED_AUTHOR_FALLBACK_LABEL;
    const participant =
      group.quotedAuthorLid ?? (quotedAuthorPhone ? `${quotedAuthorPhone.replace(/\D/gu, "")}@s.whatsapp.net` : undefined);
    await markTranscribing(d.redis, conversationId, d.transcribingTtlSec); // segura o flush até transcrever
    const payload: WhatsappTranscriptionPayload = {
      orgId: resolved.orgId,
      ref,
      conversationId,
      instanceId,
      audio: {
        base64: "",
        mimetype: "audio/ogg",
        messageKey: { id: group.quotedStanzaId, remoteJid: group.groupJid, fromMe: false, ...(participant ? { participant } : {}) },
      },
      quotedAudioContext: { userText: inbound.text, authorLabel },
    };
    await d.transcriptionQueue.add(WHATSAPP_TRANSCRIPTION_JOB, payload, {
      attempts: WHATSAPP_TRANSCRIPTION_ATTEMPTS,
      backoff: { type: "exponential", delay: WHATSAPP_TRANSCRIPTION_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: true,
    });
    await scheduleConversationFlush(d.flushQueue, { orgId: resolved.orgId, conversationId, ref }, d.debounceMs);
    d.logger.debug({ conversationId }, "inbound:group_quoted_audio");
    return;
  }

  // authorName + citação no meta → atribuição + "em resposta a X" da dirigida no transcript.
  // Captura o reply mesmo quando é ao PRÓPRIO bot (contexto útil pros outros participantes):
  // marca `quotedFromBot` p/ o transcript rotular como o assistente (não o telefone do bot).
  const quotedSnippet = quotedSnippetDisplay(group);
  const quotedFromBot = quotedAuthorPhone !== null && quotedAuthorPhone === botPhone;
  await routeMessage(d, instanceId, inbound, resolved.orgId, conversationId, ref, {
    authorName: group.senderName,
    ...(quotedAuthorPhone ? { quotedAuthorPhone } : {}),
    ...(quotedSnippet ? { quotedSnippet } : {}),
    ...(quotedFromBot ? { quotedFromBot: true } : {}),
  });
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
    messaging: ports.messaging,
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
    groupParticipantsCacheTtlSec: deps.conversation.groupParticipantsCacheTtlSec,
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
