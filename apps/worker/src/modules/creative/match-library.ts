// Escolha CONTEXT-AWARE do criativo da biblioteca (Fatia 7 — decisão do dono): dado o contexto
// da campanha (objetivo + negócio + orientações), o LLM escolhe entre as DESCRIÇÕES cacheadas
// (visão feita no upload) qual criativo MELHOR CASA — não é ranking genérico/aleatório. Texto
// only (usa o cache, não re-analisa visão) → barato. Falha/sem descrição → cai na recência.

import type { AudienceStage } from "@trafego/shared";
import type { LLMProviderPort, LLMMessage, LLMCallMeta } from "@trafego/shared/ports";
import { LLMProviderError } from "@trafego/shared/ports";

export interface LibraryCandidate {
  readonly assetId: string;
  /** descrição cacheada da visão (summary + gancho/ângulo/formato) — o que o criativo comunica. */
  readonly description: string;
  /** força de prova percebida (S4c) — contexto extra, nunca critério sozinho (fit continua liderando). */
  readonly proofStrength?: "weak" | "medium" | "strong";
  /** nº de gatilhos de persuasão de Cialdini presentes, 0-7 (S4c). */
  readonly persuasionSignals?: number;
  /** fraquezas notadas pela visão (S4c) — ex: "CTA fraco". */
  readonly weaknesses?: readonly string[];
}

export interface MatchContext {
  readonly goal: string;
  readonly businessContext?: string | null;
  readonly guidance?: string | null;
  /** estágio do público da campanha NOVA (S3) — a mensagem que casa com frio ≠ a que casa com quente.
   *  Neutro (o adapter derivou do targeting); `unknown`/ausente = não pontua estágio no prompt. */
  readonly campaignStage?: AudienceStage;
  /** copy do anúncio VENCEDOR da conta (S3) — dá o TEMA/OFERTA de referência pro matcher alinhar a
   *  mensagem do criativo escolhido; nunca é ordem de copiar, só contexto de encaixe. */
  readonly winnerCopy?: string | null;
}

/** Rótulo PT do estágio pro prompt (o LLM lê linguagem de negócio, não a taxonomia). */
const STAGE_PROMPT_LABEL: Readonly<Record<AudienceStage, string>> = {
  prospecting: "prospecção (público frio, ainda não conhece o negócio)",
  remarketing: "remarketing (público quente, já interagiu/conhece)",
  unknown: "",
};

const MATCH_TEMPERATURE = 0.2;
const MATCH_MAX_TOKENS = 200;

const MATCH_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    index: { type: "number" },
    why: { type: ["string", "null"] },
  },
  required: ["index", "why"],
  additionalProperties: false,
};

function buildMessages(ctx: MatchContext, candidates: readonly LibraryCandidate[]): LLMMessage[] {
  const system =
    "Você escolhe qual criativo da BIBLIOTECA melhor se encaixa numa NOVA campanha, pelo CONTEXTO " +
    "(objetivo de negócio, contexto do negócio, orientações) e pela descrição de cada criativo. " +
    "Não escolha por 'qualidade genérica' — escolha o que mais CASA com o objetivo/negócio desta " +
    "campanha (mensagem, ângulo e formato alinhados). Prova/persuasão/fraquezas (quando presentes) são " +
    "sinal extra, não critério sozinho: só desempatam entre candidatos de fit equivalente — nunca vencem " +
    "um encaixe melhor. Responda só o índice (0-based) do melhor.";
  const list = candidates.map((c, i) => `[${i}] ${describeCandidateForPrompt(c)}`).join("\n");
  const stageLabel = ctx.campaignStage ? STAGE_PROMPT_LABEL[ctx.campaignStage] : "";
  const parts = [
    `Objetivo da campanha: ${ctx.goal}.`,
    stageLabel ? `Estágio do público: ${stageLabel}.` : "",
    ctx.businessContext ? `Contexto do negócio: ${ctx.businessContext}` : "",
    ctx.guidance ? `Orientações: ${ctx.guidance}` : "",
    ctx.winnerCopy ? `Tema/oferta de referência (do anúncio que mais converte): ${ctx.winnerCopy}` : "",
    "",
    "Criativos disponíveis (índice + descrição):",
    list,
    "",
    'Responda SOMENTE JSON: { "index": <n>, "why": "<motivo curto>" }',
  ].filter(Boolean);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

/** Descrição + sinais de qualidade (S4c), quando presentes — omite o que não veio (nunca inventa placeholder). */
function describeCandidateForPrompt(c: LibraryCandidate): string {
  const signals = [
    c.proofStrength ? `prova: ${c.proofStrength}` : "",
    typeof c.persuasionSignals === "number" ? `persuasão: ${c.persuasionSignals}/7` : "",
    c.weaknesses && c.weaknesses.length > 0 ? `fraquezas: ${c.weaknesses.join(", ")}` : "",
  ].filter(Boolean);
  return signals.length > 0 ? `${c.description} (${signals.join(" · ")})` : c.description;
}

/**
 * Escolhe o assetId que melhor casa com o contexto. 0 candidatos → null; 1 → ele mesmo (sem
 * LLM); ≥2 → LLM decide pela descrição × contexto. Índice inválido / erro de LLM → o 1º da lista
 * (que o caller ordena por recência) — nunca quebra o fluxo de criação. PURA quanto ao IO (llm
 * injetado, testável).
 */
export async function pickLibraryCreativeByContext(
  llm: Pick<LLMProviderPort, "completeStructured">,
  model: string,
  ctx: MatchContext,
  candidates: readonly LibraryCandidate[],
): Promise<string | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.assetId;
  try {
    const completion = await llm.completeStructured<{ index?: number }>({
      model,
      messages: buildMessages(ctx, candidates),
      responseSchema: MATCH_SCHEMA,
      responseSchemaName: "library_creative_match",
      temperature: MATCH_TEMPERATURE,
      maxTokens: MATCH_MAX_TOKENS,
    });
    const i = completion.output?.index;
    return typeof i === "number" && Number.isInteger(i) && i >= 0 && i < candidates.length
      ? candidates[i]!.assetId
      : candidates[0]!.assetId;
  } catch (err) {
    if (!(err instanceof LLMProviderError)) throw err;
    return candidates[0]!.assetId; // fallback: recência (1º da lista)
  }
}

/** Mensagens p/ casar a REFERÊNCIA do usuário ("o vídeo da praia") com a descrição de cada criativo. */
function buildReferenceMessages(reference: string, candidates: readonly LibraryCandidate[]): LLMMessage[] {
  const system =
    "O usuário está se referindo a UM criativo que já mandou/tem, pelo CONTEÚDO ('o vídeo da praia', " +
    "'o do 50% off', 'o depoimento'). Escolha, pela descrição de cada um, qual criativo ele quer dizer. " +
    "Se NENHUM casar de forma razoável com a referência, responda index -1 (não force um encaixe ruim). " +
    "Responda só o índice (0-based), ou -1.";
  const list = candidates.map((c, i) => `[${i}] ${describeCandidateForPrompt(c)}`).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: `Referência do usuário: "${reference}"\n\nCriativos (índice + descrição):\n${list}\n\nResponda SOMENTE JSON: { "index": <n | -1>, "why": "<motivo curto>" }` },
  ];
}

/**
 * Escolhe o criativo que o usuário está referindo POR DESCRIÇÃO (Slice 3). 0 candidatos → null; 1 →
 * ele mesmo; ≥2 → LLM casa a referência × descrições. Diferente de `pickLibraryCreativeByContext`
 * (que casa com o contexto de uma NOVA campanha), aqui o alvo é a fala do usuário sobre um criativo
 * existente — e admite "nenhum" (index -1) pra não trazer o errado. Erro de LLM → null (não chuta).
 */
export async function pickCreativeByReference(
  llm: Pick<LLMProviderPort, "completeStructured">,
  model: string,
  reference: string,
  candidates: readonly LibraryCandidate[],
  meta?: LLMCallMeta,
): Promise<string | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.assetId;
  try {
    const completion = await llm.completeStructured<{ index?: number }>({
      model,
      messages: buildReferenceMessages(reference, candidates),
      responseSchema: MATCH_SCHEMA,
      responseSchemaName: "creative_reference_match",
      temperature: MATCH_TEMPERATURE,
      maxTokens: MATCH_MAX_TOKENS,
      ...(meta ? { meta } : {}),
    });
    const i = completion.output?.index;
    return typeof i === "number" && Number.isInteger(i) && i >= 0 && i < candidates.length ? candidates[i]!.assetId : null;
  } catch (err) {
    if (!(err instanceof LLMProviderError)) throw err;
    return null; // ambíguo demais / erro → não chuta um criativo errado
  }
}
