// Montagem PURA das mensagens do LLM. Belt-and-suspenders: além do structured
// output (json_schema), o formato JSON vai como TEXTO no prompt. Padrões adotados
// do automato-api: GROUNDING_RULE + FINDINGS_METRIC_INSTRUCTION.

import type { AccountBrief, CreativeVisionResult, EntitySummary } from "@trafego/shared";
import type { AnalysisOutput, UnitAnalysis } from "@trafego/shared/schemas";
import type { LLMMessage } from "@trafego/shared/ports";
import type { FindingIssue } from "@trafego/core";

/** Anti-alucinação (adotado do automato). */
export const GROUNDING_RULE =
  "Baseie-se apenas nos dados do briefing e cite os números reais. Não invente métricas.";

/** metricRefs com "dente": finding sem métrica é descartado (o usuário perde o conteúdo). */
export const FINDINGS_METRIC_INSTRUCTION =
  'Todo item de "findings" DEVE ter ao menos 1 "metricRefs" (label + value) do briefing que o ' +
  "sustente — inclusive achados qualitativos (ancore na métrica mais próxima: CTR, CPA, gasto, taxa " +
  "de resposta etc.). Findings sem metricRefs são descartados.";

/** Forma esperada do JSON (espelha analysisOutputSchema) — PT-BR, conciso. */
const OUTPUT_SHAPE = `{
  "scorecard": { "grade": "A|B|C|D", "headline": "string (1 frase: onde a conta está vs onde deveria)", "biggestLeak": "consciencia|engajamento|conversao|receita" },
  "summary": "string (2-4 frases, resumo executivo, cite números)",
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

const FUNNEL_NOTE =
  "O briefing pode trazer 'funnel' (funil de messaging): conversas iniciadas, 1ª resposta e " +
  "profundidade, com taxas. Trate como QUALIDADE do lead (não só volume): taxa de resposta/" +
  "profundidade baixa é problema mesmo com muitas conversas.";

const jsonBlock = (label: string, value: unknown): string =>
  `${label}:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** Mensagens do ANALISTA (system = metodologia; user = brief + shape). */
export function buildAnalysisMessages(systemPrompt: string, brief: AccountBrief): LLMMessage[] {
  const system = [systemPrompt, GROUNDING_RULE, FUNNEL_NOTE, FINDINGS_METRIC_INSTRUCTION].join("\n\n");
  const user = [
    jsonBlock("Briefing curado da conta (analise SOMENTE com base nele)", brief),
    "",
    "Responda SOMENTE com JSON válido (sem markdown), no formato:",
    OUTPUT_SHAPE,
    "",
    "targetEntity: use apenas ids que aparecem em `segments` do briefing; senão null.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Shape do JSON por-unidade (map) — sem scorecard (é da conta, na síntese). */
const UNIT_OUTPUT_SHAPE = `{
  "summary": "string (1-2 frases sobre este anúncio, cite números)",
  "findings": [ { "id": "string", "title": "string", "detail": "string", "severity": "info|warning|critical", "metricRefs": [{ "label": "string", "value": number|string }] } ],
  "recommendations": [ { "id": "string", "title": "string", "rationale": "string", "priority": "high|medium|low", "actionType": "pause|resume|increase_budget|decrease_budget|review_creative|review_audience|investigate|keep", "targetEntity": { "level": "ad", "externalId": "string" } | null, "budgetChangePct": number | null } ],
  "flags": ["string"]
}`;

/**
 * Mensagens do MAPA (análise de UM anúncio). Contexto pequeno = alta precisão.
 * Inclui a visão do criativo (quando houver) como texto (já resolvida/cacheada).
 */
export function buildUnitMessages(
  systemPrompt: string,
  unit: EntitySummary,
  vision: readonly CreativeVisionResult[],
  accountContext: { readonly currency: string; readonly window: string },
): LLMMessage[] {
  const system = [systemPrompt, GROUNDING_RULE, FUNNEL_NOTE, FINDINGS_METRIC_INSTRUCTION].join("\n\n");
  const user = [
    jsonBlock("Anúncio a analisar (dados curados — analise SÓ com base neles)", unit),
    vision.length > 0 ? jsonBlock("Análise do(s) criativo(s) deste anúncio (visão)", vision) : "",
    jsonBlock("Contexto da conta", accountContext),
    "",
    "targetEntity: use o id deste anúncio quando a ação for sobre ele; senão null.",
    "Responda SOMENTE com JSON válido (sem markdown), no formato:",
    UNIT_OUTPUT_SHAPE,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Mensagens da SÍNTESE (reduce): consolida as análises por-anúncio + o contexto
 * da conta num diagnóstico único (scorecard + recomendações cross-entidade).
 */
export function buildSynthesisMessages(
  systemPrompt: string,
  brief: AccountBrief,
  units: readonly UnitAnalysis[],
): LLMMessage[] {
  const system = [
    systemPrompt,
    "Você recebe análises por-anúncio + o contexto da conta. Consolide numa visão ÚNICA da conta: " +
      "priorize o que mais importa, agrupe temas repetidos e proponha as recomendações de maior impacto.",
    GROUNDING_RULE,
    FUNNEL_NOTE,
    FINDINGS_METRIC_INSTRUCTION,
  ].join("\n\n");
  const user = [
    jsonBlock("Contexto da conta (totais, funil, tendências, anomalias)", brief),
    jsonBlock("Análises por-anúncio (mapa)", units),
    "",
    "Responda SOMENTE com JSON válido (sem markdown), no formato:",
    OUTPUT_SHAPE,
    "",
    "targetEntity: use apenas ids que aparecem em `segments` do contexto; senão null.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Mensagens do REVISOR — refina/corta, NUNCA inventa. Recebe brief + saída + flags. */
export function buildReviewMessages(
  brief: AccountBrief,
  draft: AnalysisOutput,
  issues: readonly FindingIssue[],
): LLMMessage[] {
  const system = [
    "Você é um revisor sênior de análise de tráfego. Sua tarefa é CORRIGIR a análise de outro agente.",
    "Regras: (1) confira cada número contra o briefing e corrija/remova o que não bater; (2) remova " +
      "recomendações inseguras, sem base no dado, ou que escalem o que não provou resultado; (3) ajuste " +
      "severidade/prioridade ao que o dado sustenta; (4) NÃO invente achados novos nem números.",
    GROUNDING_RULE,
    "Devolva a análise corrigida no MESMO formato JSON (sem markdown).",
  ].join("\n\n");
  const flagText = issues.length > 0
    ? issues.map((i) => `- ${i.findingId}: ${i.detail} (${i.reason})`).join("\n")
    : "(nenhum problema pré-detectado)";
  const user = [
    jsonBlock("Briefing (gabarito dos números)", brief),
    "",
    jsonBlock("Análise a revisar", draft),
    "",
    `Problemas pré-detectados (determinístico) a resolver:\n${flagText}`,
    "",
    "Responda SOMENTE com o JSON corrigido, no mesmo formato.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
