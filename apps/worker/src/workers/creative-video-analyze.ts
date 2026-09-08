// Worker BullMQ `creative-video-analyze` (Slice 2): o dono manda um vídeo no WhatsApp (marcando o
// Roy / com legenda) e o Roy analisa DOS NOSSOS BYTES — manda o vídeo COMPLETO pro modelo
// video-capable (movimento/áudio/gancho), SEM o desvio pela Meta (upload + espera `ready` + frames).
// Paralelo ao intake da biblioteca (que segue subindo pra Meta em background). Vídeo grande demais
// pro modelo OU falha → degrada com aviso honesto (a análise de biblioteca sai lá quando pronto).

import { Worker } from "bullmq";
import { mediaBytesContentHash } from "@trafego/creative-library";
import {
  CREATIVE_VIDEO_ANALYZE_JOB_ATTEMPTS,
  CREATIVE_VIDEO_ANALYZE_QUEUE,
  type CreativeVideoAnalyzePayload,
} from "@trafego/shared";
import type { CreativeVisionResult } from "@trafego/shared";
import type { CreativeVisionPort, LLMMessage, LLMProviderPort, MessagingChannelPort } from "@trafego/shared/ports";
import { LLMProviderError } from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { WorkerDeps } from "../composition.js";
import { createSendToConversation, type SendToConversation } from "../modules/notify/send-to-contact.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createVisionResolver } from "../modules/vision/resolver.js";

/** Cortesias do fluxo (§13 UX: o quê + próximo passo). */
const NOTICE = {
  noBytes: "Não consegui baixar seu vídeo pra analisar — manda de novo?",
  tooBig: "Esse vídeo é grande demais pra eu analisar aqui na hora — guardei na biblioteca e a análise dele sai por lá quando terminar de processar.",
  failed: "Recebi seu vídeo mas tive um problema pra analisar agora — guardei na biblioteca, dá uma olhada por lá.",
};

const COMPOSE_TEMPERATURE = 0.4;
const COMPOSE_MAX_TOKENS = 500;

/** Monta um resumo textual da decomposição de visão p/ o modelo redigir a resposta. */
function describeVision(v: CreativeVisionResult): string {
  const lines = [
    `Resumo: ${v.summary}`,
    v.hook ? `Gancho: ${v.hook}` : "",
    v.angle ? `Ângulo: ${v.angle}` : "",
    v.format ? `Formato: ${v.format}` : "",
    v.body ? `Corpo: ${v.body}` : "",
    v.cta ? `CTA: ${v.cta}` : "",
    v.proofStrength ? `Força de prova: ${v.proofStrength}` : "",
    typeof v.persuasionSignals === "number" ? `Gatilhos de persuasão: ${v.persuasionSignals}/7` : "",
    v.strengths.length > 0 ? `Pontos fortes: ${v.strengths.join("; ")}` : "",
    v.weaknesses.length > 0 ? `A melhorar: ${v.weaknesses.join("; ")}` : "",
    typeof v.score === "number" ? `Nota: ${v.score}/10` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function composeMessages(caption: string | null, v: CreativeVisionResult): LLMMessage[] {
  const question = caption && caption.trim().length > 0 ? caption.trim() : "O que você acha desse criativo?";
  return [
    {
      role: "system",
      content:
        "Você é o Roy, gestor de tráfego pago, respondendo no WhatsApp sobre um criativo de VÍDEO que o " +
        "dono acabou de te mandar. Use a análise abaixo pra responder à pergunta dele de forma DIRETA e " +
        "útil, como um gestor conversando — sem despejar um formulário, sem títulos, sem repetir a análise " +
        "inteira. Puxe o que importa pra pergunta (gancho, o que segura/perde atenção, o que dá pra melhorar). " +
        "Seja honesto: baseie-se só na análise, não invente métrica.",
    },
    {
      role: "user",
      content: `Pergunta do dono: ${question}\n\nAnálise do vídeo:\n${describeVision(v)}`,
    },
  ];
}

export interface VideoAnalyzeDeps {
  readonly vision: CreativeVisionPort;
  readonly llm: Pick<LLMProviderPort, "complete">;
  readonly messaging: Pick<MessagingChannelPort, "fetchMediaBase64">;
  readonly sendToConversation: SendToConversation;
  readonly messageModel: string;
  /** teto de bytes p/ mandar o vídeo INTEIRO ao modelo (acima → degrada; ffmpeg-local = fast-follow). */
  readonly videoModelMaxBytes: number;
  readonly logger: Pick<Logger, "debug" | "warn">;
}

/**
 * Núcleo testável (sem BullMQ): busca os bytes → (dentro do teto) manda o vídeo completo ao modelo
 * de visão → redige a resposta na voz do Roy → empurra. Sem bytes / grande demais / falha → aviso
 * honesto (a biblioteca ainda analisa em background). NUNCA fica em silêncio.
 */
export function makeVideoAnalyze(d: VideoAnalyzeDeps) {
  return async function analyze(p: CreativeVideoAnalyzePayload): Promise<void> {
    // probe por `fileLength` ANTES de baixar (evita puxar um vídeo enorme pra memória só pra rejeitar).
    if (p.fileLength !== undefined && p.fileLength > d.videoModelMaxBytes) {
      d.logger.debug({ conversationId: p.conversationId, fileLength: p.fileLength }, "video-analyze:acima do teto (probe) — degrada");
      await d.sendToConversation(p.ref, NOTICE.tooBig, { split: true, quoteLastInbound: true });
      return;
    }
    const b64 = await d.messaging.fetchMediaBase64({ instanceId: p.instanceId }, p.messageKey);
    if (!b64 || b64.length === 0) {
      await d.sendToConversation(p.ref, NOTICE.noBytes, { split: true });
      return;
    }
    const bytes = Buffer.from(b64, "base64");
    if (bytes.byteLength > d.videoModelMaxBytes) {
      d.logger.debug({ conversationId: p.conversationId, bytes: bytes.byteLength }, "video-analyze:acima do teto — degrada");
      await d.sendToConversation(p.ref, NOTICE.tooBig, { split: true, quoteLastInbound: true });
      return;
    }
    // content-addressed pelos BYTES (estável, sem depender do asset) — o ingest grava o MESMO hash
    // em `creative_assets.vision_content_hash` (fonte única), então a busca por descrição liga o
    // asset à esta decomposição.
    const contentHash = mediaBytesContentHash(bytes);
    const dataUrl = `data:${p.mimetype};base64,${b64}`;
    const vision = await d.vision.resolve({ creativeId: p.messageKey.id, imageUrls: [], videoUrl: dataUrl, contentHash });
    if (!vision) {
      await d.sendToConversation(p.ref, NOTICE.failed, { split: true, quoteLastInbound: true });
      return;
    }
    let answer: string;
    try {
      const completion = await d.llm.complete({ model: d.messageModel, messages: composeMessages(p.caption, vision), temperature: COMPOSE_TEMPERATURE, maxTokens: COMPOSE_MAX_TOKENS, meta: { orgId: p.orgId, type: "message" } });
      answer = completion.output.trim();
    } catch (err) {
      if (!(err instanceof LLMProviderError)) throw err;
      d.logger.warn({ conversationId: p.conversationId, err }, "video-analyze:redação falhou");
      await d.sendToConversation(p.ref, NOTICE.failed, { split: true, quoteLastInbound: true });
      return;
    }
    await d.sendToConversation(p.ref, answer.length > 0 ? answer : NOTICE.failed, { split: true, quoteLastInbound: true });
    d.logger.debug({ conversationId: p.conversationId }, "video-analyze:respondido");
  };
}

const BYTES_PER_MB = 1024 * 1024;

/** Start do worker: monta o resolver de visão COM o modelo de vídeo (video_url → modelo video-capable). */
export function startCreativeVideoAnalyzeWorker(deps: WorkerDeps, connection: Redis): Worker<CreativeVideoAnalyzePayload> {
  const { db, ports, logger } = deps;
  const vision: CreativeVisionPort = createVisionResolver({
    db,
    llm: ports.llm,
    model: deps.analysis.visionModel,
    videoModel: deps.analysis.videoModel,
    analyzerVersion: deps.visionAnalyzerVersion,
    logger,
  });
  const analyze = makeVideoAnalyze({
    vision,
    llm: ports.llm,
    messaging: ports.messaging,
    sendToConversation: createSendToConversation({ messaging: ports.messaging, repo: createNotifyRepo(db) }),
    messageModel: deps.analysis.messageModel,
    videoModelMaxBytes: deps.analysis.videoModelMaxMb * BYTES_PER_MB,
    logger,
  });
  return new Worker<CreativeVideoAnalyzePayload>(
    CREATIVE_VIDEO_ANALYZE_QUEUE,
    async (job) => analyze(job.data),
    { connection, autorun: true },
  );
}
