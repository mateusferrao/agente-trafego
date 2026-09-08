import type { JobSpec } from "../ports/scheduler.port.js";
import type { MediaMessageKey } from "../ports/messaging-channel.port.js";
import type { ConversationRef } from "./whatsapp.js";

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
/** retry do BullMQ p/ throw no CORPO do job (blip de DB no setStatus / Redis no re-enqueue) —
 *  sem isso a cadeia morreria num blip transiente (job attempts=1 + removeOnFail). */
export const CREATIVE_VIDEO_POLL_JOB_ATTEMPTS = 3;
export const CREATIVE_VIDEO_POLL_JOB_BACKOFF_MS = 5_000;

// `type` (não `interface`) → assignável a `JobSpec.payload` (Record<string, unknown>).
export type CreativeVideoPollPayload = {
  readonly orgId: string;
  /** id INTERNO da conta (uuid) — o worker resolve o token via ela. */
  readonly adAccountId: string;
  readonly assetId: string;
  readonly metaVideoId: string;
  /** tentativa atual (1-based) — cap em CREATIVE_VIDEO_POLL_MAX_ATTEMPTS. */
  readonly attempt: number;
  /**
   * Contexto de conversa p/ o fecho-de-loop de vídeo (B1): quando o vídeo veio de um intake do
   * WhatsApp com escrita conversacional LIGADA, o poll oferece "usar/criar" ao flipar `ready`.
   * Ausente = upload web (sem conversa) OU escrita OFF → sem oferta.
   */
  readonly offer?: { readonly ref: ConversationRef; readonly conversationId: string };
};

/** Job de poll (delayado). Sem idempotencyKey: cada tentativa é um job fresco (a cadeia
 *  se auto-limita pelo attempt cap; dedup de conteúdo já evita asset duplicado no intake). */
export function buildCreativeVideoPollJob(payload: CreativeVideoPollPayload): JobSpec {
  return {
    queue: CREATIVE_VIDEO_POLL_QUEUE,
    name: CREATIVE_VIDEO_POLL_JOB,
    payload,
    delayMs: CREATIVE_VIDEO_POLL_DELAY_MS,
    attempts: CREATIVE_VIDEO_POLL_JOB_ATTEMPTS,
    backoffMs: CREATIVE_VIDEO_POLL_JOB_BACKOFF_MS,
    removeOnComplete: true,
    removeOnFail: true,
  };
}

// ─── Análise de VISÃO de criativo da biblioteca (upload) ──────────────────────────────
// Cada upload é analisado UMA vez pela visão (reusa o resolver + o cache creative_vision_analyses,
// os mesmos dos veiculados) → descrição fica disponível pro agente sem repetir custo. Imagem usa
// nosso blob (data-url, zero call Meta); vídeo usa os frames da Meta (video_id). Enfileirado no
// upload (imagem) ou quando o poll flipa o vídeo pra `ready`. Idempotente pelo cache do resolver.
export const CREATIVE_ANALYZE_QUEUE = "creative-analyze";
export const CREATIVE_ANALYZE_JOB = "analyze-creative";
export const CREATIVE_ANALYZE_JOB_ATTEMPTS = 3;
export const CREATIVE_ANALYZE_JOB_BACKOFF_MS = 5_000;

export type CreativeAnalyzePayload = {
  readonly orgId: string;
  /** id INTERNO da conta (uuid) — o worker resolve o token via ela (só p/ vídeo). */
  readonly adAccountId: string;
  readonly assetId: string;
};

export function buildCreativeAnalyzeJob(payload: CreativeAnalyzePayload): JobSpec {
  return {
    queue: CREATIVE_ANALYZE_QUEUE,
    name: CREATIVE_ANALYZE_JOB,
    payload,
    // idempotente por conteúdo no cache do resolver → 1 job por asset basta. (jobId não pode
    // conter ':' — BullMQ rejeita; usa '-'.)
    idempotencyKey: `creative-analyze-${payload.assetId}`,
    attempts: CREATIVE_ANALYZE_JOB_ATTEMPTS,
    backoffMs: CREATIVE_ANALYZE_JOB_BACKOFF_MS,
    removeOnComplete: true,
    removeOnFail: true,
  };
}

// ─── Análise CONVERSACIONAL de VÍDEO enviado no WhatsApp (Slice 2) ─────────────────────
// O dono manda um vídeo (marcando o Roy / com legenda) e o Roy analisa DOS NOSSOS BYTES: manda o
// vídeo COMPLETO pro modelo video-capable (movimento/áudio/gancho) — SEM o desvio pela Meta (upload
// + espera `ready` + frames). Fila PRÓPRIA (paralela ao intake da biblioteca, que segue subindo
// pra Meta em background). Falha/parse → degrada com aviso honesto (a análise de biblioteca sai lá).
export const CREATIVE_VIDEO_ANALYZE_QUEUE = "creative-video-analyze";
export const CREATIVE_VIDEO_ANALYZE_JOB = "analyze-whatsapp-video";
export const CREATIVE_VIDEO_ANALYZE_JOB_ATTEMPTS = 3;
export const CREATIVE_VIDEO_ANALYZE_JOB_BACKOFF_MS = 5_000;

export type CreativeVideoAnalyzePayload = {
  readonly orgId: string;
  readonly ref: ConversationRef;
  readonly conversationId: string;
  readonly instanceId: string;
  /** chave da mídia p/ buscar os bytes por fora do webhook (`fetchMediaBase64`). */
  readonly messageKey: MediaMessageKey;
  readonly mimetype: string;
  /** legenda/pergunta do usuário (o que ele quer saber do criativo). */
  readonly caption: string | null;
  /** tamanho do arquivo (bytes) informado pelo WhatsApp — probe ANTES de baixar (evita OOM). */
  readonly fileLength?: number;
};

export function buildCreativeVideoAnalyzeJob(payload: CreativeVideoAnalyzePayload): JobSpec {
  return {
    queue: CREATIVE_VIDEO_ANALYZE_QUEUE,
    name: CREATIVE_VIDEO_ANALYZE_JOB,
    payload,
    attempts: CREATIVE_VIDEO_ANALYZE_JOB_ATTEMPTS,
    backoffMs: CREATIVE_VIDEO_ANALYZE_JOB_BACKOFF_MS,
    removeOnComplete: true,
    removeOnFail: true,
  };
}
