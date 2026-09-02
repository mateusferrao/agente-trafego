// Geração de COPY por IA (Fatia 7) — structured output, tom sóbrio B2B (guardrail:
// conteúdo encaminhável ao cliente do gestor). Aterrada em copy do vencedor +
// contexto/orientações do agente. N variações compartilham a mesma mídia (teste de copy).
// Fallback determinístico quando o LLM falha (nunca deixa o rascunho sem copy).

import { AI_JARGON_BLOCKLIST } from "@trafego/core";
import { CTA_TYPES, type ConversionGoal, type CopyVariant } from "@trafego/shared";
import type { LLMProviderPort } from "@trafego/shared/ports";
import { LLMProviderError } from "@trafego/shared/ports";

const COPY_SCHEMA_NAME = "ad_copy_variants";
const COPY_TEMPERATURE = 0.7;
const COPY_MAX_TOKENS = 800;

const COPY_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          primaryText: { type: "string" },
          headline: { type: "string" },
          description: { type: ["string", "null"] },
          cta: { type: ["string", "null"], enum: [...CTA_TYPES, null] },
        },
        required: ["primaryText", "headline", "description", "cta"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
};

export interface GenerateCopyInput {
  readonly model: string;
  readonly goal: ConversionGoal;
  readonly variantsCount: number;
  readonly businessContext?: string | null;
  readonly guidance?: string | null;
  /** copy do vencedor (aterramento) — texto/título de anúncios que já performam. */
  readonly winnerCopy?: ReadonlyArray<{ readonly primaryText?: string; readonly headline?: string }>;
}

export interface GenerateCopyMeta {
  readonly orgId?: string;
  readonly runId?: string;
  readonly adAccountId?: string;
}

interface CopyOutput {
  readonly variants?: ReadonlyArray<{
    readonly primaryText?: string;
    readonly headline?: string;
    readonly description?: string | null;
    readonly cta?: string | null;
  }>;
}

function systemPrompt(): string {
  return [
    "Você escreve copy de anúncio para o Meta Ads, em português do Brasil.",
    "Tom SÓBRIO e profissional (B2B): o texto pode ser encaminhado ao cliente do gestor —",
    "sem sensacionalismo, sem promessas exageradas, sem emoji em excesso.",
    // audiência = cliente final; não é a voz do Roy, mas o anti-jargão-de-IA vale igual.
    `Nunca use jargão de IA nem clichê de marketing vazio (ex: ${AI_JARGON_BLOCKLIST.join(", ")}).`,
    "Cada variação: texto principal curto, título objetivo, descrição opcional e um CTA.",
    "As variações compartilham a mesma mídia — varie o ângulo da copy, não a oferta.",
  ].join(" ");
}

function userPrompt(input: GenerateCopyInput): string {
  const parts: string[] = [`Objetivo de negócio: ${input.goal}.`, `Gere ${input.variantsCount} variações.`];
  if (input.businessContext) parts.push(`Contexto do negócio: ${input.businessContext}`);
  if (input.guidance) parts.push(`Orientações: ${input.guidance}`);
  if (input.winnerCopy && input.winnerCopy.length > 0) {
    const sample = input.winnerCopy
      .slice(0, 3)
      .map((c) => `- ${c.headline ?? ""} | ${c.primaryText ?? ""}`)
      .join("\n");
    parts.push(`Copy que já performa (aterre-se nela, sem copiar):\n${sample}`);
  }
  return parts.join("\n");
}

function normalizeCta(cta: string | null | undefined): CopyVariant["cta"] {
  return cta && (CTA_TYPES as readonly string[]).includes(cta) ? (cta as CopyVariant["cta"]) : undefined;
}

/** Fallback determinístico — reusa a copy do vencedor ou um texto neutro por objetivo. */
function fallbackVariants(input: GenerateCopyInput): CopyVariant[] {
  const base = input.winnerCopy?.[0];
  const headline = base?.headline ?? "Conheça nossa oferta";
  const primaryText = base?.primaryText ?? "Descubra o que preparamos para você.";
  return Array.from({ length: Math.max(1, input.variantsCount) }, (_, i) => ({
    primaryText: i === 0 ? primaryText : `${primaryText} (${i + 1})`,
    headline,
  }));
}

/**
 * Gera N variações de copy. Structured output validado; falha do LLM → fallback
 * determinístico. `llm` injetado (testável sem provider real).
 */
export async function generateCopy(
  llm: Pick<LLMProviderPort, "completeStructured">,
  input: GenerateCopyInput,
  meta: GenerateCopyMeta = {},
): Promise<CopyVariant[]> {
  try {
    const completion = await llm.completeStructured<CopyOutput>({
      model: input.model,
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPrompt(input) },
      ],
      responseSchema: COPY_OUTPUT_JSON_SCHEMA,
      responseSchemaName: COPY_SCHEMA_NAME,
      temperature: COPY_TEMPERATURE,
      maxTokens: COPY_MAX_TOKENS,
      meta: { ...meta, type: "copy" },
    });
    const variants = completion.output?.variants ?? [];
    const mapped = variants
      .filter((v) => typeof v.primaryText === "string" && typeof v.headline === "string")
      .slice(0, input.variantsCount)
      .map((v): CopyVariant => {
        const cta = normalizeCta(v.cta);
        return {
          primaryText: v.primaryText!.trim(),
          headline: v.headline!.trim(),
          ...(v.description ? { description: v.description.trim() } : {}),
          ...(cta ? { cta } : {}),
        };
      });
    return mapped.length > 0 ? mapped : fallbackVariants(input);
  } catch (err) {
    if (!(err instanceof LLMProviderError)) throw err;
    return fallbackVariants(input);
  }
}
