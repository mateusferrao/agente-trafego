// Montagem PURA das mensagens do LLM p/ a análise. Belt-and-suspenders: além do
// structured output (response_format json_schema), o formato JSON também vai como
// TEXTO no prompt — modelos que ignoram o schema ainda seguem a instrução.

import type { AccountBrief } from "@trafego/shared";
import type { LLMMessage } from "@trafego/shared/ports";

/** Forma esperada do JSON (espelha analysisOutputSchema) — em PT-BR, conciso. */
const OUTPUT_SHAPE = `{
  "summary": "string (2-4 frases; resumo executivo, cite números reais)",
  "findings": [
    { "id": "string", "title": "string", "detail": "string",
      "severity": "info|warning|critical",
      "metricRefs": [{ "label": "string", "value": number|string }] }
  ],
  "recommendations": [
    { "id": "string", "title": "string", "rationale": "string",
      "priority": "high|medium|low",
      "actionType": "pause|resume|increase_budget|decrease_budget|review_creative|review_audience|investigate|keep",
      "targetEntity": { "level": "account|campaign|adset|ad", "externalId": "string" } | null,
      "budgetChangePct": number | null }
  ]
}`;

export function buildAnalysisMessages(systemPrompt: string, brief: AccountBrief): LLMMessage[] {
  const user = [
    "Briefing curado da conta (JSON) — analise SOMENTE com base nele:",
    "```json",
    JSON.stringify(brief),
    "```",
    "",
    "Responda SOMENTE com JSON válido (sem markdown, sem texto fora do JSON), no formato:",
    OUTPUT_SHAPE,
    "",
    "Regras do targetEntity: use apenas ids que aparecem no briefing (campo `id` das",
    "entidades em `segments`). Se a sugestão não tem alvo aplicável, use null.",
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: user },
  ];
}
