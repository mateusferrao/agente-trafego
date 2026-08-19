// Redator dedicado do WhatsApp (papel dedicado, inspirado no mission.conversation.write
// do automato): recebe o resultado CURADO e devolve só o texto da mensagem. Grounded
// (só números da síntese), voz do arquétipo, WhatsApp-first. Saída {text} mínima.

import type { AnalysisOutput } from "@trafego/shared/schemas";
import type { LLMMessage } from "@trafego/shared/ports";
import { GROUNDING_RULE } from "../analysis/prompt.js";

/** Structured output do redator — um único campo de texto. */
export const MESSAGE_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
export const MESSAGE_OUTPUT_SCHEMA_NAME = "whatsapp_message";

/** Máx. de recomendações a citar na mensagem (WhatsApp-first). */
const MAX_RECS = 3;

const VOICE_RULES = [
  "Escreva a mensagem de WhatsApp para o dono da conta (linguagem de gente, sem jargão técnico).",
  "Curta e escaneável: 1 decisão por linha. Comece pelo diagnóstico (1 frase), depois as sugestões.",
  "Não inclua IDs internos, JSON, nem markdown pesado. Sem saudação longa. Use no máx. 3 sugestões.",
  "Não invente números nem ações: use SOMENTE o que está no resultado fornecido.",
].join(" ");

/** Monta as mensagens do redator. `systemPrompt` = persona/metodologia do arquétipo. */
export function buildMessageMessages(
  systemPrompt: string,
  accountName: string,
  output: AnalysisOutput,
): LLMMessage[] {
  const system = [systemPrompt, VOICE_RULES, GROUNDING_RULE].join("\n\n");
  const curated = {
    accountName,
    scorecard: output.scorecard,
    summary: output.summary,
    recommendations: output.recommendations.slice(0, MAX_RECS).map((r) => ({
      title: r.title,
      rationale: r.rationale,
    })),
  };
  const user = [
    "Resultado curado da análise (base da mensagem):",
    "```json",
    JSON.stringify(curated),
    "```",
    "",
    'Responda SOMENTE com JSON no formato { "text": "..." } — o texto pronto p/ enviar no WhatsApp.',
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
