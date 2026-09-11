// Worker BullMQ `creative-video-analyze` (Slice 2): o dono manda um vídeo no WhatsApp (marcando o
// Roy / com legenda) e o Roy analisa DOS NOSSOS BYTES — manda o vídeo COMPLETO pro modelo
// video-capable (movimento/áudio/gancho), SEM o desvio pela Meta (upload + espera `ready` + frames).
// Paralelo ao intake da biblioteca (que segue subindo pra Meta em background). Vídeo grande demais
// pro modelo OU falha → degrada com aviso honesto (a análise de biblioteca sai lá quando pronto).

import { Queue, Worker } from "bullmq";
import { mediaBytesContentHash } from "@trafego/creative-library";
import {
  CREATIVE_VIDEO_ANALYZE_QUEUE,
  WHATSAPP_FLUSH_QUEUE,
  type CreativeVideoAnalyzePayload,
  type WhatsappFlushPayload,
} from "@trafego/shared";
import type { CreativeVisionResult } from "@trafego/shared";
import type { CreativeVisionPort, LLMMessage, LLMProviderPort, MessagingChannelPort } from "@trafego/shared/ports";
import { LLMProviderError } from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { WorkerDeps } from "../composition.js";
import { BUFFER_TTL_MARGIN_SEC, pushInbound } from "../modules/conversation/buffer.js";
import { scheduleConversationFlush, unmarkTranscribing } from "../modules/conversation/flush-control.js";
import { createSendToConversation, type SendToConversation } from "../modules/notify/send-to-contact.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createVisionResolver } from "../modules/vision/resolver.js";

const BYTES_PER_MB = 1024 * 1024;

/** Cortesias do fluxo (§13 UX: o quê + próximo passo). */
const NOTICE = {
  noBytes: "Não consegui baixar seu vídeo pra analisar — manda de novo?",
  // grande p/ o modelo, MAS dentro do teto do intake → o intake salva e a análise de biblioteca sai lá.
  tooBigForModel: "Esse vídeo é grande demais pra eu analisar aqui na hora — guardei na biblioteca e a análise dele sai por lá quando terminar de processar.",
  // acima do teto do intake → o intake REJEITA (não salva) → não prometer biblioteca; aponta o site.
  tooLargeForLibrary: (maxMb: number) =>
    `Esse vídeo é grande demais pra eu receber por aqui (limite ${maxMb}MB) — sobe ele pela biblioteca de criativos no site.`,
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
  /** Encaminha a legenda (instrução de negócio) pro Grafo B — o grafo com tools é dono da resposta
   *  (comenta o criativo via recall_creative + AGE). Só quando há legenda; sem legenda = opinião do
   *  fast-path. Empurra a legenda no buffer + LIBERA o hold (unmark + flush) → coalesce com msgs
   *  concorrentes num turno só. Chamado DEPOIS da visão persistir, pro recall achar sem corrida. */
  readonly handoffToConversation: (p: CreativeVideoAnalyzePayload) => Promise<void>;
  /** Libera o hold do flush (a legenda segurou o turno enquanto a visão rodava, igual ao áudio) SEM
   *  empurrar legenda — desfechos que NÃO encaminham (opinião/aviso). Assim uma msg concorrente que
   *  ficou represada durante a análise finalmente flusha. */
  readonly releaseHold: (p: CreativeVideoAnalyzePayload) => Promise<void>;
  readonly messageModel: string;
  /** teto de bytes p/ mandar o vídeo INTEIRO ao modelo (acima → degrada; ffmpeg-local = fast-follow). */
  readonly videoModelMaxBytes: number;
  /** teto de bytes do INTAKE (biblioteca) — acima dele o intake rejeita, então não prometer biblioteca. */
  readonly libraryMaxBytes: number;
  readonly logger: Pick<Logger, "debug" | "warn">;
}

/**
 * Aviso de vídeo grande demais p/ análise ao vivo. Distingue os dois tetos: acima do teto do INTAKE
 * (biblioteca) o arquivo NÃO é salvo → aponta o site (não promete biblioteca); entre o teto do modelo
 * e o do intake, o intake salva e a análise sai por lá → promete a biblioteca (honesto).
 */
function oversizeNotice(d: VideoAnalyzeDeps, sizeBytes: number): string {
  return sizeBytes > d.libraryMaxBytes
    ? NOTICE.tooLargeForLibrary(Math.round(d.libraryMaxBytes / BYTES_PER_MB))
    : NOTICE.tooBigForModel;
}

/**
 * Núcleo testável (sem BullMQ): busca os bytes → (dentro do teto) manda o vídeo completo ao modelo
 * de visão → redige a resposta na voz do Roy → empurra. Sem bytes / grande demais / falha → aviso
 * honesto (a biblioteca ainda analisa em background). NUNCA fica em silêncio.
 */
export function makeVideoAnalyze(d: VideoAnalyzeDeps) {
  return async function analyze(p: CreativeVideoAnalyzePayload): Promise<void> {
    // Legenda = INSTRUÇÃO (ex.: "coloque na campanha X"). Presente → o Grafo B (com tools) é dono da
    // resposta: comenta via recall_creative + AGE; o fast-path só PRODUZ a visão e cala. Sem legenda →
    // opinião do fast-path (como hoje). O `handoff` só vale quando o vídeo VAI VIRAR asset (intake
    // salva): sem bytes / grande demais pro intake não há asset → aviso honesto, sem encaminhar.
    const hasInstruction = (p.caption ?? "").trim().length > 0;
    // probe por `fileLength` ANTES de baixar (evita puxar um vídeo enorme pra memória só pra rejeitar).
    if (p.fileLength !== undefined && p.fileLength > d.videoModelMaxBytes) {
      if (hasInstruction && p.fileLength <= d.libraryMaxBytes) return d.handoffToConversation(p); // salvo → age; Grafo B é honesto sobre a análise
      d.logger.debug({ conversationId: p.conversationId, fileLength: p.fileLength }, "video-analyze:acima do teto (probe) — degrada");
      await d.sendToConversation(p.ref, oversizeNotice(d, p.fileLength), { split: true, quoteLastInbound: true });
      return d.releaseHold(p);
    }
    const b64 = await d.messaging.fetchMediaBase64({ instanceId: p.instanceId }, p.messageKey);
    if (!b64 || b64.length === 0) {
      await d.sendToConversation(p.ref, NOTICE.noBytes, { split: true });
      return d.releaseHold(p);
    }
    const bytes = Buffer.from(b64, "base64");
    if (bytes.byteLength > d.videoModelMaxBytes) {
      if (hasInstruction && bytes.byteLength <= d.libraryMaxBytes) return d.handoffToConversation(p);
      d.logger.debug({ conversationId: p.conversationId, bytes: bytes.byteLength }, "video-analyze:acima do teto — degrada");
      await d.sendToConversation(p.ref, oversizeNotice(d, bytes.byteLength), { split: true, quoteLastInbound: true });
      return d.releaseHold(p);
    }
    // content-addressed pelos BYTES (estável, sem depender do asset) — o ingest grava o MESMO hash
    // em `creative_assets.vision_content_hash` (fonte única), então a busca por descrição liga o
    // asset à esta decomposição.
    const contentHash = mediaBytesContentHash(bytes);
    const dataUrl = `data:${p.mimetype};base64,${b64}`;
    const vision = await d.vision.resolve({ creativeId: p.messageKey.id, imageUrls: [], videoUrl: dataUrl, contentHash, meta: { orgId: p.orgId } });
    // A visão já persistiu (cache) quando `vision` veio. Com legenda → encaminha pro Grafo B (mesmo se
    // a visão falhou: a ação não depende dela; o recall é honesto sobre não ter análise ainda).
    if (hasInstruction) return d.handoffToConversation(p);
    if (!vision) {
      await d.sendToConversation(p.ref, NOTICE.failed, { split: true, quoteLastInbound: true });
      return d.releaseHold(p);
    }
    let answer: string;
    try {
      const completion = await d.llm.complete({ model: d.messageModel, messages: composeMessages(p.caption, vision), temperature: COMPOSE_TEMPERATURE, maxTokens: COMPOSE_MAX_TOKENS, meta: { orgId: p.orgId, type: "message" } });
      answer = completion.output.trim();
    } catch (err) {
      if (!(err instanceof LLMProviderError)) throw err; // erro inesperado → NÃO libera (retry mantém o hold; TTL é o backstop)
      d.logger.warn({ conversationId: p.conversationId, err }, "video-analyze:redação falhou");
      await d.sendToConversation(p.ref, NOTICE.failed, { split: true, quoteLastInbound: true });
      return d.releaseHold(p);
    }
    await d.sendToConversation(p.ref, answer.length > 0 ? answer : NOTICE.failed, { split: true, quoteLastInbound: true });
    d.logger.debug({ conversationId: p.conversationId }, "video-analyze:respondido");
    await d.releaseHold(p);
  };
}

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
  // Handoff pro Grafo B: mesma fila/buffer/hold do inbound (whatsapp-transcription faz igual). O
  // webhook marca `transcribing` (segura o flush) ao enfileirar o vídeo-pergunta; aqui LIBERAMOS o
  // hold ao terminar — a legenda + qualquer msg concorrente coalescem num turno só. O turno roda
  // DEPOIS (debounce), com a visão já no cache.
  const flushQueue = new Queue<WhatsappFlushPayload>(WHATSAPP_FLUSH_QUEUE, { connection });
  const debounceMs = deps.conversation.debounceSeconds * 1000;
  const bufferTtlSec = deps.conversation.debounceSeconds + BUFFER_TTL_MARGIN_SEC;
  const releaseHold = async (p: CreativeVideoAnalyzePayload): Promise<void> => {
    await unmarkTranscribing(connection, p.conversationId);
    await scheduleConversationFlush(flushQueue, { orgId: p.orgId, conversationId: p.conversationId, ref: p.ref }, debounceMs);
  };
  const analyze = makeVideoAnalyze({
    vision,
    llm: ports.llm,
    messaging: ports.messaging,
    sendToConversation: createSendToConversation({ messaging: ports.messaging, repo: createNotifyRepo(db) }),
    handoffToConversation: async (p) => {
      await pushInbound(connection, p.conversationId, (p.caption ?? "").trim(), bufferTtlSec);
      await releaseHold(p);
    },
    releaseHold,
    messageModel: deps.analysis.messageModel,
    videoModelMaxBytes: deps.analysis.videoModelMaxMb * BYTES_PER_MB,
    libraryMaxBytes: deps.creative.maxWhatsappVideoBytes,
    logger,
  });
  return new Worker<CreativeVideoAnalyzePayload>(
    CREATIVE_VIDEO_ANALYZE_QUEUE,
    async (job) => analyze(job.data),
    { connection, autorun: true },
  );
}
