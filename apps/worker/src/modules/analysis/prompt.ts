// Montagem PURA das mensagens do LLM. Belt-and-suspenders: além do structured
// output (json_schema), o formato JSON vai como TEXTO no prompt. Padrões adotados
// do automato-api: GROUNDING_RULE + FINDINGS_METRIC_INSTRUCTION.

import type { AccountBrief, CampaignUnit, CreativeVisionResult } from "@trafego/shared";
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

const WASTE_NOTE =
  "Se o briefing trouxer 'waste', LIDERE por ele (o 'money shot'): diga em reais quanto está sendo " +
  "queimado ('wastedSpend' = campanhas paradas/sem resultado, com % do total) e onde o gasto está " +
  "MAL ALOCADO ('pareto.misallocated' = leva muito gasto e entrega pouco resultado). Fale em dinheiro " +
  "e ação (pausar libera R$X; realocar de A p/ B), não só em 'vai mal'.";

const TRACKING_NOTE =
  "Se o briefing trouxer 'trackingHealth' (suspect=true), a MEDIÇÃO de venda/lead da conta parece " +
  "incompleta: há muita conversa e pouquíssima conversão de negócio rastreada. Trate como HIPÓTESE " +
  "(nunca veredito): provavelmente as vendas fecham fora do rastreio (ex: atendimento no WhatsApp) e " +
  "não voltam pro pixel/CAPI. NÃO conclua que os anúncios vão mal só pelo CPA de venda; recomende " +
  "conferir pixel/CAPI antes de pausar/cortar por CPA de venda, e apoie-se no funil como qualidade.";

/** Honestidade do descasamento meta-de-negócio × objetivo da entidade (Fatia 4). */
const MISMATCH_NOTE =
  "Cada entidade traz 'conversionBasis': 'target' = o CPA/ROAS mostrado É a conversão de " +
  "negócio do agente (pode comparar com a meta); 'proxy' = a conversão de negócio (ex: venda) " +
  "NÃO é mensurável nessa entidade porque ela otimiza outra coisa — o campo 'proxy' traz o custo " +
  "do objetivo próprio da entidade (ex: custo por conversa) apenas como REFERÊNCIA, NUNCA como " +
  "venda: não declare meta batida, deixe explícito que a venda não é rastreada ali e use o funil " +
  "como sinal de qualidade; 'none' = sem conversão, julgue por CPC/CPM. Nunca trate custo de " +
  "proxy barato como sucesso de negócio.";

/** Tiers + sinais + elegibilidade (Fatia 6c) — como o LLM deve ler e agir. */
const QUALITY_NOTE =
  "Cada entidade pode trazer 'tier' (winner/performer/underperformer/zombie), 'healthSignals' " +
  "(creative_fatigue = fadiga de criativo; audience_saturation = público saturado; low_volume = " +
  "pouco dado) e 'eligibility' (hasSignificance, inLearning). Aja assim: proteja os WINNERS (não " +
  "mexa no que vai bem), priorize PAUSAR os ZOMBIES (gasto sem conversão = desperdício), conserte os " +
  "UNDERPERFORMERS. NUNCA recomende ESCALAR (aumentar orçamento / reativar) uma entidade sem " +
  "hasSignificance ou em inLearning — nesse caso recomende investigar ou aguardar mais dados.";

/** Diagnóstico por padrão de métrica (causa provável, não só sintoma) — squad. */
const DIAGNOSIS_NOTE =
  "Ao explicar um problema, aponte a CAUSA provável pelo padrão das métricas: CTR baixo → gancho/" +
  "criativo fraco ou segmentação errada; CTR ok mas pouca conversa/conversão → página/oferta ou " +
  "qualificação do lead; conversão ok mas CPA alto → lance/orçamento ou concorrência; alcance baixo " +
  "→ público estreito ou orçamento baixo; frequência alta + CTR caindo → fadiga de criativo (renove).";

/** Referência de plataforma (cold-start) — direcional, nunca a meta. */
const BENCHMARK_NOTE =
  "Se uma entidade trouxer 'benchmarkRef' (cold-start: conta sem meta e sem histórico), trate-o só " +
  "como REFERÊNCIA DE MERCADO direcional — nunca como a meta do dono e nunca declare sucesso por ele. " +
  "Sempre convide o dono a definir a meta (CPA/ROAS/custo por conversa) pra uma leitura precisa.";

const jsonBlock = (label: string, value: unknown): string =>
  `${label}:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** Mensagens do ANALISTA (system = metodologia; user = brief + shape). */
export function buildAnalysisMessages(systemPrompt: string, brief: AccountBrief): LLMMessage[] {
  const system = [systemPrompt, GROUNDING_RULE, FUNNEL_NOTE, MISMATCH_NOTE, QUALITY_NOTE, DIAGNOSIS_NOTE, BENCHMARK_NOTE, FINDINGS_METRIC_INSTRUCTION].join("\n\n");
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

/** Shape do JSON por-campanha (map) — sem scorecard (é da conta, na síntese). */
const CAMPAIGN_OUTPUT_SHAPE = `{
  "summary": "string (1-2 frases sobre esta campanha, cite números)",
  "findings": [ { "id": "string", "title": "string", "detail": "string", "severity": "info|warning|critical", "metricRefs": [{ "label": "string", "value": number|string }] } ],
  "recommendations": [ { "id": "string", "title": "string", "rationale": "string", "priority": "high|medium|low", "actionType": "pause|resume|increase_budget|decrease_budget|review_creative|review_audience|investigate|keep", "targetEntity": { "level": "campaign|adset|ad", "externalId": "string" } | null, "budgetChangePct": number | null } ],
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
): LLMMessage[] {
  const system = [systemPrompt, GROUNDING_RULE, FUNNEL_NOTE, MISMATCH_NOTE, QUALITY_NOTE, DIAGNOSIS_NOTE, BENCHMARK_NOTE, FINDINGS_METRIC_INSTRUCTION].join("\n\n");
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
): LLMMessage[] {
  const system = [
    systemPrompt,
    "Você recebe análises por-campanha + o contexto da conta. Consolide numa visão ÚNICA da conta: " +
      "priorize o que mais importa, agrupe temas repetidos e proponha as recomendações de maior impacto.",
    GROUNDING_RULE,
    FUNNEL_NOTE,
    WASTE_NOTE,
    TRACKING_NOTE,
    MISMATCH_NOTE,
    QUALITY_NOTE,
    DIAGNOSIS_NOTE,
    BENCHMARK_NOTE,
    FINDINGS_METRIC_INSTRUCTION,
  ].join("\n\n");
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
