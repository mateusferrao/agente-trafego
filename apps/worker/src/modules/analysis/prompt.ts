// Montagem PURA das mensagens do LLM. Belt-and-suspenders: além do structured
// output (json_schema), o formato JSON vai como TEXTO no prompt. Padrões adotados
// do automato-api: GROUNDING_RULE + FINDINGS_METRIC_INSTRUCTION.

import type { AccountBrief, CampaignUnit, CreativeVisionResult } from "@trafego/shared";
import type { AnalysisOutput, UnitAnalysis } from "@trafego/shared/schemas";
import type { LLMMessage } from "@trafego/shared/ports";
import {
  REVIEW_KNOWLEDGE_CONTEXT,
  buildAnalysisKnowledgeText,
  buildCampaignKnowledgeContext,
  buildSynthesisKnowledgeContext,
  buildVerticalKnowledgeText,
  resolveVerticalProfile,
  type FindingIssue,
} from "@trafego/core";

/** Anti-alucinação (adotado do automato). */
export const GROUNDING_RULE =
  "Baseie-se apenas nos dados do briefing e cite os números reais. Não invente métricas.";

/** metricRefs com "dente": finding sem métrica é descartado (o usuário perde o conteúdo). */
export const FINDINGS_METRIC_INSTRUCTION =
  'Todo item de "findings" DEVE ter ao menos 1 "metricRefs" (label + value) do briefing que o ' +
  "sustente — inclusive achados qualitativos (ancore na métrica mais próxima: CTR, CPA, gasto, taxa " +
  "de resposta etc.). Findings sem metricRefs são descartados. EXCEÇÃO: um achado QUALITATIVO/de " +
  'compliance sem número que o sustente (ex: linguagem de criativo que pode violar diretriz do ' +
  'nicho) pode vir com "caveat": true e "metricRefs": [] em vez de ser descartado — mas se você ' +
  "citar um número, ele TEM que bater com o briefing (o caveat não afrouxa a verificação numérica).";

/** Taxonomia da recomendação (G4): impacto em R$, o que monitorar, e o link ao finding. */
export const RECOMMENDATION_TAXONOMY_INSTRUCTION =
  '"expectedImpact" (texto curto, ex: "libera ~R$450/semana") só quando você conseguir ancorar num ' +
  "número REAL do briefing (mesma regra do GROUNDING_RULE) — na dúvida, deixe null; NÃO estime um " +
  'valor em R$ sem base no dado. "whatToMonitor" (texto curto) diz qual métrica/sinal acompanhar ' +
  'depois de aplicar (ex: "CPA nos próximos 3 dias"). "findingRefs" lista os "id" de "findings" que ' +
  "motivaram esta recomendação (vazio se nenhum finding específico a sustenta).";

/** Forma esperada do JSON (espelha analysisOutputSchema) — PT-BR, conciso. */
const OUTPUT_SHAPE = `{
  "scorecard": { "grade": "A|B|C|D", "headline": "string (1 frase: onde a conta está vs onde deveria)", "biggestLeak": "consciencia|engajamento|conversao|receita" },
  "summary": "string (2-4 frases, resumo executivo, cite números)",
  "findings": [
    { "id": "string", "title": "string", "detail": "string",
      "severity": "info|warning|critical",
      "metricRefs": [{ "label": "string", "value": number|string }],
      "caveat": boolean | null }
  ],
  "recommendations": [
    { "id": "string", "title": "string", "rationale": "string",
      "priority": "high|medium|low",
      "actionType": "pause|resume|increase_budget|decrease_budget|review_creative|review_audience|investigate|keep",
      "targetEntity": { "level": "account|campaign|adset|ad", "externalId": "string" } | null,
      "budgetChangePct": number | null,
      "expectedImpact": string | null,
      "whatToMonitor": string | null,
      "findingRefs": string[] | null }
  ]
}`;

/** Texto do perfil vertical (S4, G6) — anexado PROGRAMATICAMENTE, nunca embutido no
 *  `systemPrompt` editável; sobrevive a qualquer override de persona/orientações. */
const verticalText = (vertical: string | undefined): string => buildVerticalKnowledgeText(resolveVerticalProfile(vertical));

const jsonBlock = (label: string, value: unknown): string =>
  `${label}:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** Shape do JSON por-campanha (map) — sem scorecard (é da conta, na síntese). */
const CAMPAIGN_OUTPUT_SHAPE = `{
  "summary": "string (1-2 frases sobre esta campanha, cite números)",
  "findings": [ { "id": "string", "title": "string", "detail": "string", "severity": "info|warning|critical", "metricRefs": [{ "label": "string", "value": number|string }], "caveat": boolean | null } ],
  "recommendations": [ { "id": "string", "title": "string", "rationale": "string", "priority": "high|medium|low", "actionType": "pause|resume|increase_budget|decrease_budget|review_creative|review_audience|investigate|keep", "targetEntity": { "level": "campaign|adset|ad", "externalId": "string" } | null, "budgetChangePct": number | null, "expectedImpact": string | null, "whatToMonitor": string | null, "findingRefs": string[] | null } ],
  "flags": ["string"]
}`;

/**
 * Mensagens do MAPA (análise de UMA campanha). A campanha vem como árvore curada
 * (adsets ativos + anúncios notáveis + cauda agregada por adset); a visão dos
 * criativos dos anúncios notáveis (quando houver) entra como texto, indexada por adId.
 * O LLM pode agir na entidade certa (campanha/adset/anúncio) — o id vem na árvore.
 */
/** Copy real (verbatim) de um anúncio p/ o prompt — texto principal/título/CTA. */
export interface AdCopy {
  readonly body?: string;
  readonly title?: string;
  readonly callToAction?: string;
}

export function buildCampaignMessages(
  systemPrompt: string,
  unit: CampaignUnit,
  visionByAdId: ReadonlyMap<string, readonly CreativeVisionResult[]>,
  accountContext: { readonly currency: string; readonly window: string; readonly businessGoal?: string },
  copyByAdId: ReadonlyMap<string, AdCopy> = new Map(),
  vertical?: string,
): LLMMessage[] {
  const system = [
    systemPrompt,
    GROUNDING_RULE,
    verticalText(vertical),
    buildAnalysisKnowledgeText(buildCampaignKnowledgeContext(unit)),
    FINDINGS_METRIC_INSTRUCTION,
    RECOMMENDATION_TAXONOMY_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");
  const notableAdIds = unit.adsets.flatMap((g) => g.notableAds.map((a) => a.id));
  const vision = notableAdIds
    .map((adId) => ({ adId, vision: visionByAdId.get(adId) ?? [] }))
    .filter((v) => v.vision.length > 0);
  // Copy VERBATIM (complementa a visão: visão = interpretação, copy = texto real) —
  // habilita direção de criativo e responder "qual copy campeã".
  const copy = notableAdIds
    .map((adId) => ({ adId, copy: copyByAdId.get(adId) }))
    .filter((c): c is { adId: string; copy: AdCopy } => {
      const k = c.copy;
      return k != null && Boolean(k.body || k.title || k.callToAction);
    });
  const user = [
    jsonBlock(
      "Campanha a analisar (árvore curada: adsets + anúncios notáveis + cauda agregada — analise SÓ com base nela)",
      unit,
    ),
    vision.length > 0 ? jsonBlock("Análise dos criativos dos anúncios notáveis (visão, por adId)", vision) : "",
    copy.length > 0 ? jsonBlock("Copy real dos anúncios notáveis (texto verbatim, por adId)", copy) : "",
    jsonBlock("Contexto da conta", accountContext),
    "",
    "targetEntity: aponte a entidade certa (campaign, adset ou ad) usando o id que aparece na árvore; senão null.",
    "Responda SOMENTE com JSON válido (sem markdown), no formato:",
    CAMPAIGN_OUTPUT_SHAPE,
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
  vertical?: string,
): LLMMessage[] {
  const system = [
    systemPrompt,
    "Você recebe análises por-campanha + o contexto da conta. Consolide numa visão ÚNICA da conta: " +
      "priorize o que mais importa, agrupe temas repetidos e proponha as recomendações de maior impacto.",
    GROUNDING_RULE,
    verticalText(vertical),
    buildAnalysisKnowledgeText(buildSynthesisKnowledgeContext(brief)),
    FINDINGS_METRIC_INSTRUCTION,
    RECOMMENDATION_TAXONOMY_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");
  const user = [
    jsonBlock("Contexto da conta (totais, funil, tendências, anomalias)", brief),
    jsonBlock("Análises por-campanha (mapa)", units),
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
  vertical?: string,
): LLMMessage[] {
  const system = [
    "Você é um revisor sênior de análise de tráfego. Sua tarefa é CORRIGIR a análise de outro agente.",
    "Regras: (1) confira cada número contra o briefing e corrija/remova o que não bater; (2) remova " +
      "recomendações inseguras, sem base no dado, ou que escalem o que não provou resultado; (3) ajuste " +
      "severidade/prioridade ao que o dado sustenta; (4) NÃO invente achados novos nem números.",
    GROUNDING_RULE,
    verticalText(vertical),
    // G7: o revisor corrige contra a MESMA régua de domínio que o analista usou (não só
    // confere número) — sem isso, ele podia manter uma recomendação numericamente certa
    // mas que viola a leitura de qualidade/incrementalidade/tracking do domínio.
    buildAnalysisKnowledgeText(REVIEW_KNOWLEDGE_CONTEXT),
    RECOMMENDATION_TAXONOMY_INSTRUCTION,
    "Devolva a análise corrigida no MESMO formato JSON (sem markdown).",
  ]
    .filter(Boolean)
    .join("\n\n");
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
