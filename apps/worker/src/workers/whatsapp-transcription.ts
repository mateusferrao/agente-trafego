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
  type WhatsappFlushPayload,
  type WhatsappTranscriptionPayload,
} from "@trafego/shared";
import { TranscriptionError } from "@trafego/shared/ports";
import type { MeteringPort, TranscriptionPort } from "@trafego/shared/ports";
import type { OrgId, TranscriptionResult } from "@trafego/shared/types";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { WorkerDeps } from "../composition.js";
import { pushInbound, BUFFER_TTL_MARGIN_SEC } from "../modules/conversation/buffer.js";
import { scheduleConversationFlush, unmarkTranscribing } from "../modules/conversation/flush-control.js";
import { sendCourtesyNotice } from "../modules/conversation/courtesy-notice.js";
import { AUDIO_EMPTY_NOTICE, AUDIO_FAILED_NOTICE } from "../modules/conversation/notices.js";
import { createNotifyRepo, type NotifyRepo } from "../modules/notify/repo.js";
import { createSendToContact, type SendToContact } from "../modules/notify/send-to-contact.js";

const MB = 1024 * 1024;
/** Erros permanentes: não adianta re-tentar o mesmo áudio → caminho de falha na hora. */
const PERMANENT_KINDS = new Set(["unsupported_format", "too_large"]);

/** Dependências do processor (interface enxuta p/ testar sem BullMQ nem WorkerDeps inteiro). */
export interface TranscriptionProcessorDeps {
  readonly transcription: TranscriptionPort;
  readonly metering: MeteringPort;
  readonly redis: Redis;
  readonly flushQueue: Queue<WhatsappFlushPayload>;
  readonly sendToContact: SendToContact;
  readonly repo: Pick<NotifyRepo, "updateMessageContent" | "focusedAdAccountId">;
  readonly logger: Pick<Logger, "warn">;
  readonly debounceSeconds: number;
  readonly maxAudioMb: number;
  readonly language: string;
}

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
  args: { orgId: string; conversationId: string; contactId: string; result: TranscriptionResult },
): Promise<void> {
  const adAccountId = await d.repo.focusedAdAccountId(args.conversationId);
  await d.metering.record({
    orgId: args.orgId as OrgId,
    ...(adAccountId ? { adAccountId } : {}),
    type: "transcription",
    provider: "openrouter",
    model: args.result.model,
    ...(args.result.costUsd != null ? { costUsd: args.result.costUsd } : {}),
    payload: {
      conversationId: args.conversationId,
      contactId: args.contactId,
      ...(args.result.durationSec != null ? { durationSec: args.result.durationSec } : {}),
      ...(args.result.tokensUsed != null ? { tokensUsed: args.result.tokensUsed } : {}),
    },
  });
}

/** Fábrica do processor — pura de BullMQ, testável com fakes. */
export function makeTranscriptionProcessor(d: TranscriptionProcessorDeps) {
  return async function process(job: TranscriptionJob): Promise<void> {
    const { orgId, contactId, conversationId, messageRowId, audio } = job.data;
    const flushPayload: WhatsappFlushPayload = { orgId, contactId, conversationId };
    const settle = async (): Promise<void> => {
      await unmarkTranscribing(d.redis, conversationId);
      await scheduleConversationFlush(d.flushQueue, flushPayload, d.debounceSeconds * 1000);
    };

    try {
      const bytes = Buffer.from(audio.base64, "base64");
      if (bytes.length === 0) throw new TranscriptionError("unsupported_format", "áudio sem bytes (base64 vazio)");
      if (bytes.length > d.maxAudioMb * MB) throw new TranscriptionError("too_large", `áudio acima de ${d.maxAudioMb}MB`);

      const language = d.language.trim();
      const result = await d.transcription.transcribe({
        bytes,
        mimetype: audio.mimetype,
        ...(language ? { language } : {}),
      });

      // custo ao metering mesmo se o texto vier vazio — houve chamada/custo (§11).
      await recordUsage(d, { orgId, conversationId, contactId, result });

      const durationPatch = result.durationSec != null ? { durationSec: result.durationSec } : {};
      const text = result.text.trim();
      if (text.length === 0) {
        await d.repo.updateMessageContent(messageRowId, null, { transcribing: false, empty: true, ...durationPatch });
        await sendCourtesyNotice(d.redis, d.sendToContact, {
          conversationId,
          contactId,
          text: AUDIO_EMPTY_NOTICE,
          throttleSec: d.debounceSeconds,
        });
        await settle();
        return;
      }

      await d.repo.updateMessageContent(messageRowId, text, { transcribing: false, ...durationPatch });
      await pushInbound(d.redis, conversationId, text, d.debounceSeconds + BUFFER_TTL_MARGIN_SEC);
      await settle();
    } catch (err) {
      const permanent = err instanceof TranscriptionError && PERMANENT_KINDS.has(err.kind);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      // transitório com tentativa sobrando → deixa a BullMQ re-tentar (NÃO settle: a flag segura o flush).
      if (!permanent && !lastAttempt) throw err;

      d.logger.warn({ conversationId, err: String(err) }, "transcription:falhou");
      await d.repo.updateMessageContent(messageRowId, null, { transcribing: false, error: errorKind(err) });
      await sendCourtesyNotice(d.redis, d.sendToContact, {
        conversationId,
        contactId,
        text: AUDIO_FAILED_NOTICE,
        throttleSec: d.debounceSeconds,
      });
      await settle();
    }
  };
}

/** Start do worker BullMQ (composition injeta deps; connection = conexão dos Workers). */
export function startWhatsappTranscriptionWorker(deps: WorkerDeps, connection: Redis): Worker<WhatsappTranscriptionPayload> {
  const repo = createNotifyRepo(deps.db);
  const sendToContact = createSendToContact({ messaging: deps.ports.messaging, repo });
  const flushQueue = new Queue<WhatsappFlushPayload>(WHATSAPP_FLUSH_QUEUE, { connection });
  const process = makeTranscriptionProcessor({
    transcription: deps.ports.transcription,
    metering: deps.ports.metering,
    redis: deps.redis,
    flushQueue,
    sendToContact,
    repo,
    logger: deps.logger,
    debounceSeconds: deps.conversation.debounceSeconds,
    maxAudioMb: deps.transcription.maxAudioMb,
    language: deps.transcription.language,
  });
  return new Worker<WhatsappTranscriptionPayload>(WHATSAPP_TRANSCRIPTION_QUEUE, (job) => process(job), { connection });
}
