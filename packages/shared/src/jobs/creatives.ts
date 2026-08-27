import type { JobSpec } from "../ports/scheduler.port.js";

// Fila de POLL do status de vídeo (Fatia 7). Vídeo processa ASYNC na plataforma: o intake
// insere o asset `pending` e enfileira este job, que consulta getVideoStatus e re-enfileira
// com delay enquanto `processing` → flipa `ready`/`error`. Fila PRÓPRIA (não whatsapp-*):
// web e WhatsApp compartilham o mesmo poll. Reaper varre `pending` órfão (crash perdeu a cadeia).

export const CREATIVE_VIDEO_POLL_QUEUE = "creative-video-poll";
export const CREATIVE_VIDEO_POLL_JOB = "poll-video-status";
/** cadência do poll (ms) entre consultas de status. */
export const CREATIVE_VIDEO_POLL_DELAY_MS = 8_000;
/** teto de tentativas — ~16min a 8s; estourou = marca `error` (não fica pending pra sempre). */
export const CREATIVE_VIDEO_POLL_MAX_ATTEMPTS = 120;

// `type` (não `interface`) → assignável a `JobSpec.payload` (Record<string, unknown>).
export type CreativeVideoPollPayload = {
  readonly orgId: string;
  /** id INTERNO da conta (uuid) — o worker resolve o token via ela. */
  readonly adAccountId: string;
  readonly assetId: string;
  readonly metaVideoId: string;
  /** tentativa atual (1-based) — cap em CREATIVE_VIDEO_POLL_MAX_ATTEMPTS. */
  readonly attempt: number;
};

/** Job de poll (delayado). Sem idempotencyKey: cada tentativa é um job fresco (a cadeia
 *  se auto-limita pelo attempt cap; dedup de conteúdo já evita asset duplicado no intake). */
export function buildCreativeVideoPollJob(payload: CreativeVideoPollPayload): JobSpec {
  return {
    queue: CREATIVE_VIDEO_POLL_QUEUE,
    name: CREATIVE_VIDEO_POLL_JOB,
    payload,
    delayMs: CREATIVE_VIDEO_POLL_DELAY_MS,
    removeOnComplete: true,
    removeOnFail: true,
  };
}
