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
  readonly analyzerVersion: number;
  readonly logger: Logger;
  /** metering (atribuição do custo da chamada de visão). */
  readonly meta?: { readonly orgId?: string; readonly runId?: string };
}

const VISION_TEMPERATURE = 0.2;
const VISION_MAX_TOKENS = 700;

const VISION_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    hook: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    score: { type: "number" },
  },
  required: ["summary", "hook", "strengths", "weaknesses", "score"],
  additionalProperties: false,
};

/** Hash do conteúdo (imagem + copy) — chave do cache; muda se o criativo mudar. */
export function creativeContentHash(imageUrl: string, copy: string | undefined): string {
  return createHash("sha256").update(`${imageUrl}\n${copy ?? ""}`).digest("base64url");
}

function buildVisionMessages(input: CreativeVisionInput): LLMMessage[] {
  const system =
    "Você analisa criativos de anúncio (imagem + copy) para tráfego pago. Seja objetivo e " +
    "prático. Descreva o que o criativo comunica, o gancho, pontos fortes e fracos, e uma nota " +
    "0-10 de qualidade. Baseie-se SÓ no que vê e no texto dado; não invente métricas.";
  const parts = [
    { type: "text" as const, text: input.copy ? `Copy do anúncio:\n${input.copy}` : "Sem copy." },
    { type: "image_url" as const, imageUrl: input.imageUrl },
    {
      type: "text" as const,
      text: 'Responda SOMENTE JSON: { "summary": "...", "hook": "...", "strengths": ["..."], "weaknesses": ["..."], "score": 0 }',
    },
  ];
  return [
    { role: "system", content: system },
    { role: "user", content: parts },
  ];
}

/** Normaliza o output do LLM p/ o resultado neutro (hook vazio = ausente). */
function toResult(raw: { summary: string; hook: string; strengths: string[]; weaknesses: string[]; score: number }): CreativeVisionResult {
  return {
    summary: raw.summary,
    ...(raw.hook && raw.hook.trim().length > 0 ? { hook: raw.hook } : {}),
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
        const completion = await deps.llm.completeStructured<{
          summary: string;
          hook: string;
          strengths: string[];
          weaknesses: string[];
          score: number;
        }>({
          model: deps.model,
          messages: buildVisionMessages(input),
          responseSchema: VISION_JSON_SCHEMA,
          responseSchemaName: "creative_vision",
          temperature: VISION_TEMPERATURE,
          maxTokens: VISION_MAX_TOKENS,
          ...(deps.meta ? { meta: { ...deps.meta, type: "vision" } } : {}),
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
