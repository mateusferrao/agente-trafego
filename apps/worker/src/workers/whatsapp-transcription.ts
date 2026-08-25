// Worker BullMQ da fila `whatsapp-transcription` (áudio → texto na borda).
// O inbound detecta nota de voz, marca a flag `wa:transcribing` (segura o flush) e
// enfileira aqui. Este worker: transcreve (STT), grava o texto na linha da mensagem,
// mede o custo (metering §11) e empurra o texto no buffer do debounce (coalesce com
// texto picado) — ou avisa amigável em falha/vazio. Ao terminar (settle): baixa a flag
// + re-agenda o flush. Retry só p/ erro transitório (permanente/última = caminho de falha).

import { Queue, Worker } from "bullmq";
import {
  WHATSAPP_FLUSH_QUEUE,
  WHATSAPP_TRANSCRIPTION_QUEUE,
  type ConversationRef,
  type WhatsappFlushPayload,
  type WhatsappTranscriptionPayload,
} from "@trafego/shared";
import { TranscriptionError } from "@trafego/shared/ports";
import type { MessagingChannelPort, MeteringPort, TranscriptionPort } from "@trafego/shared/ports";
import type { OrgId, TranscriptionResult } from "@trafego/shared/types";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { WorkerDeps } from "../composition.js";
import { actorLabel } from "../modules/conversation/actor.js";
import { pushInbound, BUFFER_TTL_MARGIN_SEC } from "../modules/conversation/buffer.js";
import { refreshTranscribing, scheduleConversationFlush, unmarkTranscribing } from "../modules/conversation/flush-control.js";
import { sendCourtesyNotice } from "../modules/conversation/courtesy-notice.js";
import {
  AUDIO_EMPTY_NOTICE,
  AUDIO_FAILED_NOTICE,
  QUOTED_AUDIO_EMPTY_NOTE,
  QUOTED_AUDIO_UNHEARD_NOTE,
  quotedAudioPrefix,
} from "../modules/conversation/notices.js";
import { createNotifyRepo, type NotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation, type SendToConversation } from "../modules/notify/send-to-contact.js";

const MB = 1024 * 1024;
/** Erros permanentes: não adianta re-tentar o mesmo áudio → caminho de falha na hora. */
const PERMANENT_KINDS = new Set(["unsupported_format", "too_large"]);

/** Dependências do processor (interface enxuta p/ testar sem BullMQ nem WorkerDeps inteiro). */
export interface TranscriptionProcessorDeps {
  readonly transcription: TranscriptionPort;
  /** fallback quando o webhook não entrega base64 inline (quirk do ptt/audioMessage). */
  readonly messaging: Pick<MessagingChannelPort, "fetchMediaBase64">;
  readonly metering: MeteringPort;
  readonly redis: Redis;
  readonly flushQueue: Queue<WhatsappFlushPayload>;
  readonly sendToConversation: SendToConversation;
  readonly repo: Pick<NotifyRepo, "updateMessageContent" | "contextAdAccountId">;
  readonly logger: Pick<Logger, "warn">;
  readonly debounceSeconds: number;
  readonly maxAudioMb: number;
  readonly language: string;
  /** nome do provider p/ o metering — vem da config (não literal no worker genérico, §13). */
  readonly provider: string;
  /** janela (s) do throttle de aviso — dedicada, não acoplada ao debounce. */
  readonly noticeThrottleSec: number;
  /** TTL (s) da flag `wa:transcribing` — re-ancorado no início do processamento. */
  readonly transcribingTtlSec: number;
}

/** Balde de throttle dos avisos de áudio (fail/empty) — separado do de mídia (não se engolem). */
const AUDIO_NOTICE_BUCKET = "audio";

/** Job mínimo que o processor consome (BullMQ Job satisfaz; o teste passa um fake). */
export interface TranscriptionJob {
  readonly data: WhatsappTranscriptionPayload;
  readonly attemptsMade: number;
  readonly opts: { readonly attempts?: number };
}

function errorKind(err: unknown): string {
  return err instanceof TranscriptionError ? err.kind : "upstream";
}

async function recordUsage(
  d: TranscriptionProcessorDeps,
  args: { orgId: string; conversationId: string; ref: ConversationRef; result: TranscriptionResult },
): Promise<void> {
  const adAccountId = await d.repo.contextAdAccountId(args.orgId, args.conversationId);
  await d.metering.record({
    orgId: args.orgId as OrgId,
    ...(adAccountId ? { adAccountId } : {}),
    type: "transcription",
    provider: d.provider,
    model: args.result.model,
    ...(args.result.costUsd != null ? { costUsd: args.result.costUsd } : {}),
    payload: {
      conversationId: args.conversationId,
      actor: actorLabel(args.ref),
      ...(args.result.durationSec != null ? { durationSec: args.result.durationSec } : {}),
      ...(args.result.tokensUsed != null ? { tokensUsed: args.result.tokensUsed } : {}),
    },
  });
}

/** Aviso de áudio (fail/empty) throttled no balde "audio". */
async function audioNotice(d: TranscriptionProcessorDeps, conversationId: string, ref: ConversationRef, text: string): Promise<void> {
  await sendCourtesyNotice(d.redis, d.sendToConversation, {
    conversationId,
    ref,
    text,
    bucket: AUDIO_NOTICE_BUCKET,
    throttleSec: d.noticeThrottleSec,
  });
}

/** Fábrica do processor — pura de BullMQ, testável com fakes. */
export function makeTranscriptionProcessor(d: TranscriptionProcessorDeps) {
  return async function process(job: TranscriptionJob): Promise<void> {
    const { orgId, ref, conversationId, messageRowId, instanceId, audio, quotedAudioContext } = job.data;
    const flushPayload: WhatsappFlushPayload = { orgId, conversationId, ref };
    // settle = destrava a flag + re-agenda o flush. Best-effort: nunca re-lança (uma
    // falha aqui NÃO pode virar retry → re-transcrição paga). O backstop `.on("failed")`
    // cobre o caso raro do job morrer antes daqui.
    const settle = async (): Promise<void> => {
      try {
        await unmarkTranscribing(d.redis, conversationId);
        await scheduleConversationFlush(d.flushQueue, flushPayload, d.debounceSeconds * 1000);
      } catch (e) {
        d.logger.warn({ conversationId, err: String(e) }, "transcription:settle_falhou");
      }
    };

    // re-ancora o TTL da flag agora (cobre espera na fila + backoff entre tentativas).
    await refreshTranscribing(d.redis, conversationId, d.transcribingTtlSec).catch(() => {});

    // ── FASE 1: a chamada PAGA. Só esta pode disparar retry (re-transcrição). ──
    let result: TranscriptionResult;
    try {
      // Evolution às vezes não entrega o base64 inline no webhook (observado em
      // áudio/`ptt` mesmo com base64:true) — busca direto a mídia como fallback.
      const raw = audio.base64.length > 0 ? audio.base64 : await d.messaging.fetchMediaBase64({ instanceId }, audio.messageKey);
      const bytes = Buffer.from(raw ?? "", "base64");
      if (bytes.length === 0) throw new TranscriptionError("unsupported_format", "áudio sem bytes (base64 vazio, fallback também não achou a mídia)");
      if (bytes.length > d.maxAudioMb * MB) throw new TranscriptionError("too_large", `áudio acima de ${d.maxAudioMb}MB`);
      const language = d.language.trim();
      result = await d.transcription.transcribe({ bytes, mimetype: audio.mimetype, ...(language ? { language } : {}) });
    } catch (err) {
      const permanent = err instanceof TranscriptionError && PERMANENT_KINDS.has(err.kind);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      // transitório com tentativa sobrando → re-tenta SÓ a chamada (NÃO settle: a flag segura o flush).
      if (!permanent && !lastAttempt) throw err;
      d.logger.warn({ conversationId, err: String(err) }, "transcription:falhou");
      try {
        if (quotedAudioContext) {
          // não deu pra ouvir o áudio CITADO → roda o turno só com o texto do usuário + nota.
          await pushInbound(
            d.redis,
            conversationId,
            `${quotedAudioContext.userText}\n\n${QUOTED_AUDIO_UNHEARD_NOTE}`,
            d.debounceSeconds + BUFFER_TTL_MARGIN_SEC,
          );
        } else if (messageRowId) {
          await d.repo.updateMessageContent(messageRowId, null, { transcribing: false, error: errorKind(err) });
          await audioNotice(d, conversationId, ref, AUDIO_FAILED_NOTICE);
        }
      } catch (e) {
        d.logger.warn({ conversationId, err: String(e) }, "transcription:fail_persist_falhou");
      }
      await settle();
      return;
    }

    // ── FASE 2: pós-transcrição. JÁ pagamos — persistência é BEST-EFFORT, nunca re-lança
    //    (uma falha aqui não pode re-executar o job e re-cobrar a transcrição). ──
    try {
      await recordUsage(d, { orgId, conversationId, ref, result });
      if (result.costUsd == null) d.logger.warn({ conversationId, model: result.model }, "transcription:custo_ausente");
      const durationPatch = result.durationSec != null ? { durationSec: result.durationSec } : {};
      const text = result.text.trim();
      const bufTtl = d.debounceSeconds + BUFFER_TTL_MARGIN_SEC;
      if (quotedAudioContext) {
        // áudio CITADO (b): prefixa a transcrição no turno, junto do texto que o usuário digitou.
        const combined =
          text.length > 0
            ? `${quotedAudioPrefix(quotedAudioContext.authorLabel, text)}\n\n${quotedAudioContext.userText}`
            : `${quotedAudioContext.userText}\n\n${QUOTED_AUDIO_EMPTY_NOTE}`;
        await pushInbound(d.redis, conversationId, combined, bufTtl);
      } else if (text.length === 0) {
        if (messageRowId) await d.repo.updateMessageContent(messageRowId, null, { transcribing: false, empty: true, ...durationPatch });
        await audioNotice(d, conversationId, ref, AUDIO_EMPTY_NOTICE);
      } else {
        if (messageRowId) await d.repo.updateMessageContent(messageRowId, text, { transcribing: false, ...durationPatch });
        await pushInbound(d.redis, conversationId, text, bufTtl);
      }
    } catch (persistErr) {
      d.logger.warn({ conversationId, err: String(persistErr) }, "transcription:persist_falhou");
    }
    await settle();
  };
}

/** Start do worker BullMQ (composition injeta deps; connection = conexão dos Workers). */
export function startWhatsappTranscriptionWorker(deps: WorkerDeps, connection: Redis): Worker<WhatsappTranscriptionPayload> {
  const repo = createNotifyRepo(deps.db);
  const sendToConversation = createSendToConversation({ messaging: deps.ports.messaging, repo });
  const flushQueue = new Queue<WhatsappFlushPayload>(WHATSAPP_FLUSH_QUEUE, { connection });
  const process = makeTranscriptionProcessor({
    transcription: deps.ports.transcription,
    messaging: deps.ports.messaging,
    metering: deps.ports.metering,
    redis: deps.redis,
    flushQueue,
    sendToConversation,
    repo,
    logger: deps.logger,
    debounceSeconds: deps.conversation.debounceSeconds,
    maxAudioMb: deps.transcription.maxAudioMb,
    language: deps.transcription.language,
    provider: deps.transcription.provider,
    noticeThrottleSec: deps.conversation.noticeThrottleSec,
    transcribingTtlSec: deps.transcription.transcribingTtlSec,
  });
  const worker = new Worker<WhatsappTranscriptionPayload>(WHATSAPP_TRANSCRIPTION_QUEUE, (job) => process(job), { connection });
  // Backstop: se um job morrer (crash/stalled) sem passar pelo settle, destrava a flag
  // e re-agenda o flush — senão o transcript+texto ficariam presos (§9 nunca-silêncio).
  worker.on("failed", (job) => {
    if (!job) return;
    const { orgId, ref, conversationId } = job.data;
    void (async () => {
      await unmarkTranscribing(deps.redis, conversationId).catch(() => {});
      await scheduleConversationFlush(flushQueue, { orgId, conversationId, ref }, deps.conversation.debounceSeconds * 1000).catch(() => {});
    })();
  });
  return worker;
}
