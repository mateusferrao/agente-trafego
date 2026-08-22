// Controle do debounce quando há transcrição de áudio em voo (5b-2 + áudio).
// A flag `wa:transcribing:{conv}` (contador) segura o flush enquanto a nota de voz
// está sendo transcrita — o flush ESPERA (não drena) até a transcrição terminar,
// pra o transcript coalescer com texto picado no mesmo turno. Backstop: EX (timeout
// + margem) — se um job de transcrição sumir (crash), a flag expira e o flush destrava.

import { Queue } from "bullmq";
import { WHATSAPP_FLUSH_JOB, type WhatsappFlushPayload } from "@trafego/shared";
import type { Redis } from "ioredis";

const TRANSCRIBING_PREFIX = "wa:transcribing:";

function transcribingKey(conversationId: string): string {
  return `${TRANSCRIBING_PREFIX}${conversationId}`;
}

/** Marca uma transcrição em voo (INCR + TTL backstop). */
export async function markTranscribing(redis: Redis, conversationId: string, ttlSec: number): Promise<void> {
  const k = transcribingKey(conversationId);
  await redis.incr(k);
  await redis.expire(k, ttlSec);
}

/** Baixa o contador de transcrições em voo (DEL ao zerar). */
export async function unmarkTranscribing(redis: Redis, conversationId: string): Promise<void> {
  const k = transcribingKey(conversationId);
  const remaining = await redis.decr(k);
  if (remaining <= 0) await redis.del(k);
}

/** Há transcrição de áudio em voo pra esta conversa? (o flush espera enquanto sim). */
export async function isTranscribing(redis: Redis, conversationId: string): Promise<boolean> {
  const v = await redis.get(transcribingKey(conversationId));
  return v !== null && Number(v) > 0;
}

/** (Re)agenda o flush da conversa (jobId = conversationId → reinicia a janela de debounce). */
export async function scheduleConversationFlush(
  flushQueue: Pick<Queue<WhatsappFlushPayload>, "add" | "remove">,
  payload: WhatsappFlushPayload,
  delayMs: number,
): Promise<void> {
  await flushQueue.remove(payload.conversationId).catch(() => {}); // reinicia a janela
  await flushQueue.add(WHATSAPP_FLUSH_JOB, payload, {
    jobId: payload.conversationId,
    delay: delayMs,
    removeOnComplete: true,
    removeOnFail: true,
  });
}
