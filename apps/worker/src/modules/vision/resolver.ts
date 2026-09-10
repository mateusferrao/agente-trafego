// Resolver de visão de criativo (3b-2): serve do cache por (contentHash,
// analyzerVersion) e só chama o LLM multimodal em miss → "analisar todos os
// criativos" sem repetir custo a cada run. Degrada a `null` (erro/parse) sem
// quebrar a análise. Casca (IO): DB (cache) + LLM (visão).

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { creativeVisionAnalyses, type Database } from "@trafego/db";
import type {
  CreativeVisionInput,
  CreativeVisionPort,
  LLMMessage,
  LLMProviderPort,
} from "@trafego/shared/ports";
import type { CreativeVisionResult } from "@trafego/shared";
import { LLMProviderError } from "@trafego/shared/ports";
import type { Logger } from "pino";

export interface VisionResolverDeps {
  readonly db: Database;
  readonly llm: LLMProviderPort;
  readonly model: string;
  /** Modelo video-capable p/ input `videoUrl` (vídeo completo). Ausente → cai no `model`. */
  readonly videoModel?: string;
  readonly analyzerVersion: number;
  readonly logger: Logger;
  /** metering (atribuição do custo da chamada de visão). */
  readonly meta?: { readonly orgId?: string; readonly runId?: string };
}

const VISION_TEMPERATURE = 0.2;
const VISION_MAX_TOKENS = 900;

const VISION_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    hook: { type: "string" },
    angle: { type: "string" },
    format: { type: "string" },
    cta: { type: "string" },
    body: { type: "string" },
    proofStrength: { type: "string", enum: ["weak", "medium", "strong"] },
    persuasionSignals: { type: "integer", minimum: 0, maximum: 7 },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    score: { type: "number" },
  },
  required: ["summary", "hook", "angle", "format", "cta", "body", "proofStrength", "persuasionSignals", "strengths", "weaknesses", "score"],
  additionalProperties: false,
};

const PROOF_STRENGTHS = ["weak", "medium", "strong"] as const;
type ProofStrength = (typeof PROOF_STRENGTHS)[number];

interface RawVision {
  summary: string;
  hook: string;
  angle: string;
  format: string;
  cta: string;
  body: string;
  proofStrength: string;
  persuasionSignals: number;
  strengths: string[];
  weaknesses: string[];
  score: number;
}

/**
 * Hash do conteúdo — chave do cache. Recebe um id ESTÁVEL do criativo (id/vídeo),
 * não a URL do fbcdn (que rotaciona a assinatura a cada fetch e furaria o cache).
 */
export function creativeContentHash(stableKey: string, copy: string | undefined): string {
  return createHash("sha256").update(`${stableKey}\n${copy ?? ""}`).digest("base64url");
}

/**
 * Chave de cache de visão de um anúncio VEICULANDO — FONTE ÚNICA da composição (`${creativeId}:
 * ${videoId}` + copy), usada tanto pelo run de análise quanto pela criação de campanha, pra o
 * cache-hit ser consistente. `creativeId` = id do criativo na Meta (não o ad id). Sem essa fonte
 * única, os dois lados hasheariam diferente e o cache erraria silenciosamente.
 */
export function servingVisionKey(creativeId: string, videoId: string | undefined | null, copy: string | undefined): string {
  return creativeContentHash(`${creativeId}:${videoId ?? ""}`, copy);
}

/** Os 7 gatilhos de persuasão de Cialdini — contados em `persuasionSignals`. Fonte única
 *  (reusado pela decomposição de visão E pela geração de copy, que se apoia nos mesmos gatilhos). */
export const CIALDINI_TRIGGERS =
  "reciprocidade (oferece algo antes de pedir), compromisso/coerência (pequeno passo que leva ao " +
  "maior), prova social (outros já fizeram/aprovam), autoridade (credencial/especialista), afinidade " +
  "(semelhança/simpatia com quem assiste), escassez (limitado/urgente) e unidade (faz parte do mesmo " +
  "grupo/identidade)";

function buildVisionMessages(input: CreativeVisionInput): LLMMessage[] {
  const system =
    "Você analisa criativos de anúncio (imagem/vídeo + copy) para tráfego pago. Se receber o VÍDEO " +
    "completo, considere movimento, ritmo e ÁUDIO/voz (não só o visual). Quando receber vários " +
    "frames, eles são do MESMO vídeo em ordem (abertura → fim) — analise como uma peça só. Decomponha " +
    "o criativo: o que comunica (summary), o gancho dos primeiros segundos (hook), o ângulo/apelo " +
    "central (angle), o formato (format: antes-depois/depoimento/UGC/talking-head/oferta), o corpo/" +
    "argumento central (body), a chamada pra ação (cta), a FORÇA DE PROVA (proofStrength: weak/medium/" +
    "strong — antes-depois real, autoridade/credencial, depoimento verificável elevam; promessa sem prova " +
    `é weak), a DENSIDADE PERSUASIVA (persuasionSignals: 0-7, contagem de quantos dos 7 gatilhos de ` +
    `Cialdini estão presentes no criativo — ${CIALDINI_TRIGGERS}; conte só o que está CLARAMENTE presente, ` +
    "não force), pontos fortes/fracos e uma nota 0-10 (score). Baseie-se SÓ no que vê e no texto dado; " +
    "não invente métricas.";
  // vídeo completo (video_url) quando disponível — movimento/áudio/gancho; senão frames (imagem/fallback).
  const media = input.videoUrl
    ? [{ type: "video_url" as const, videoUrl: input.videoUrl }]
    : input.imageUrls.map((url) => ({ type: "image_url" as const, imageUrl: url }));
  const parts = [
    { type: "text" as const, text: input.copy ? `Copy do anúncio:\n${input.copy}` : "Sem copy." },
    ...media,
    {
      type: "text" as const,
      text: 'Responda SOMENTE JSON: { "summary": "...", "hook": "...", "angle": "...", "format": "...", "body": "...", "cta": "...", "proofStrength": "weak|medium|strong", "persuasionSignals": 0, "strengths": ["..."], "weaknesses": ["..."], "score": 0 }',
    },
  ];
  return [
    { role: "system", content: system },
    { role: "user", content: parts },
  ];
}

/** Normaliza o output do LLM p/ o resultado neutro (campos vazios = ausentes). */
function toResult(raw: RawVision): CreativeVisionResult {
  const opt = (v: string | undefined): string | undefined => (v && v.trim().length > 0 ? v : undefined);
  const proof = PROOF_STRENGTHS.includes(raw.proofStrength as ProofStrength)
    ? (raw.proofStrength as ProofStrength)
    : undefined;
  return {
    summary: raw.summary,
    ...(opt(raw.hook) ? { hook: raw.hook } : {}),
    ...(opt(raw.angle) ? { angle: raw.angle } : {}),
    ...(opt(raw.format) ? { format: raw.format } : {}),
    ...(opt(raw.body) ? { body: raw.body } : {}),
    ...(opt(raw.cta) ? { cta: raw.cta } : {}),
    ...(proof ? { proofStrength: proof } : {}),
    ...(typeof raw.persuasionSignals === "number" ? { persuasionSignals: raw.persuasionSignals } : {}),
    strengths: raw.strengths,
    weaknesses: raw.weaknesses,
    ...(typeof raw.score === "number" ? { score: raw.score } : {}),
  };
}

export function createVisionResolver(deps: VisionResolverDeps): CreativeVisionPort {
  return {
    async resolve(input: CreativeVisionInput): Promise<CreativeVisionResult | null> {
      // 1) cache por conteúdo + versão do analisador.
      const [cached] = await deps.db
        .select({ result: creativeVisionAnalyses.result })
        .from(creativeVisionAnalyses)
        .where(
          and(
            eq(creativeVisionAnalyses.contentHash, input.contentHash),
            eq(creativeVisionAnalyses.analyzerVersion, deps.analyzerVersion),
          ),
        )
        .limit(1);
      if (cached) return cached.result;

      // 2) miss → LLM multimodal. Falha/parse → degrada a null (não quebra a análise).
      let result: CreativeVisionResult;
      try {
        const completion = await deps.llm.completeStructured<RawVision>({
          // vídeo completo → modelo video-capable; frames/imagem → modelo de visão padrão.
          model: input.videoUrl ? (deps.videoModel ?? deps.model) : deps.model,
          messages: buildVisionMessages(input),
          responseSchema: VISION_JSON_SCHEMA,
          responseSchemaName: "creative_vision",
          temperature: VISION_TEMPERATURE,
          maxTokens: VISION_MAX_TOKENS,
          // meta POR-CHAMADA (input) tem precedência sobre o de construção — o orgId varia por job.
          ...((input.meta ?? deps.meta) ? { meta: { ...deps.meta, ...input.meta, type: "vision" } } : {}),
        });
        result = toResult(completion.output);
      } catch (err) {
        if (!(err instanceof LLMProviderError)) throw err;
        deps.logger.warn({ creativeId: input.creativeId, err }, "vision:falhou; sem análise de criativo");
        return null;
      }

      // 3) grava no cache (idempotente por conteúdo+versão).
      await deps.db
        .insert(creativeVisionAnalyses)
        .values({ contentHash: input.contentHash, analyzerVersion: deps.analyzerVersion, result })
        .onConflictDoNothing();
      return result;
    },
  };
}
