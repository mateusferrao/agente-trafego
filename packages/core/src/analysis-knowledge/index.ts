// Kernel de conhecimento de domínio do analista — PURO (Fase 1/S0b, pivô saúde).
// Antes, as NOTES (`apps/worker/src/modules/analysis/prompt.ts`) eram 11 constantes
// SEMPRE injetadas por papel, mesmo quando o dado que justificava a nota não existia
// nesta conta (ex: WASTE_NOTE numa conta sem desperdício real). Cada bloco aqui carrega
// um predicado puro (`relevant`) sobre o contexto do run — só entra no prompt quando
// FAZ diferença pra ESTA análise (decisão 8 do plano do pivô saúde: NOTES condicionadas
// por relevância, a resposta arquitetural pro prompt não inflar proporcionalmente à
// soma de blocos novos das próximas fases).

import type { AccountBrief, CampaignUnit, EntitySummary } from "@trafego/shared";

/** Papel do consumidor no pipeline — cada um enxerga um subconjunto dos blocos. */
export type AnalysisKnowledgeRole = "map" | "synthesis" | "review";

/** Contexto mínimo (derivado do brief/unit) que os predicados de relevância leem. */
export interface AnalysisKnowledgeContext {
  readonly role: AnalysisKnowledgeRole;
  /** conta tem desperdício REAL (zumbi com gasto OU má alocação no pareto) — não só o campo presente. */
  readonly hasWaste: boolean;
  readonly trackingSuspect: boolean;
  readonly hasRevenue: boolean;
  readonly hasBenchmarkRef: boolean;
  /** alguma entidade no escopo (conta ou campanha) traz `budget`/`atBudgetCeiling` (S1). */
  readonly hasBudgetData: boolean;
}

/** Agrupamento temático (G2) — ordena a montagem do texto, não a lista de blocos. */
export type AnalysisKnowledgeTheme = "conversao" | "qualidade" | "criativo" | "desperdicio" | "orcamento" | "benchmark";

export interface AnalysisKnowledgeBlock {
  readonly key: string;
  readonly theme: AnalysisKnowledgeTheme;
  readonly text: string;
  readonly relevant: (ctx: AnalysisKnowledgeContext) => boolean;
}

const isMapOrSynthesis = (ctx: AnalysisKnowledgeContext): boolean => ctx.role === "map" || ctx.role === "synthesis";
/** Blocos-base de leitura de dado (funil/honestidade/qualidade/causa) — domínio puro,
 *  úteis também pro REVISOR corrigir contra a mesma régua que o analista usou (G7). */
const isAnalysisRole = (ctx: AnalysisKnowledgeContext): boolean => ctx.role === "map" || ctx.role === "synthesis" || ctx.role === "review";

const FUNNEL_TEXT =
  "O briefing pode trazer 'funnel' (funil de messaging): conversas iniciadas, 1ª resposta e " +
  "profundidade, com taxas. Trate como QUALIDADE do lead (não só volume): taxa de resposta/" +
  "profundidade baixa é problema mesmo com muitas conversas.";

const WASTE_TEXT =
  "Se o briefing trouxer 'waste', LIDERE por ele (o 'money shot'): diga em reais quanto está sendo " +
  "queimado ('wastedSpend' = campanhas paradas/sem resultado, com % do total) e onde o gasto está " +
  "MAL ALOCADO ('pareto.misallocated' = leva muito gasto e entrega pouco resultado). Fale em dinheiro " +
  "e ação (pausar libera <valor> no período, na moeda da conta; realocar de A p/ B), não só em 'vai mal'.";

const TRACKING_TEXT =
  "Se o briefing trouxer 'trackingHealth' (suspect=true), a MEDIÇÃO de venda/lead da conta parece " +
  "incompleta: há muita conversa e pouquíssima conversão de negócio rastreada. Trate como HIPÓTESE " +
  "(nunca veredito): provavelmente as vendas fecham fora do rastreio (ex: atendimento no WhatsApp) e " +
  "não voltam pro pixel/CAPI. NÃO conclua que os anúncios vão mal só pelo CPA de venda; recomende " +
  "conferir pixel/CAPI antes de pausar/cortar por CPA de venda, e apoie-se no funil como qualidade.";

/** Honestidade do descasamento meta-de-negócio × objetivo da entidade (Fatia 4). */
const MISMATCH_TEXT =
  "Cada entidade traz 'conversionBasis': 'target' = o CPA/ROAS mostrado É a conversão de " +
  "negócio do agente (pode comparar com a meta); 'proxy' = a conversão de negócio (ex: venda) " +
  "NÃO é mensurável nessa entidade porque ela otimiza outra coisa — o campo 'proxy' traz o custo " +
  "do objetivo próprio da entidade (ex: custo por conversa) apenas como REFERÊNCIA, NUNCA como " +
  "venda: não declare meta batida, deixe explícito que a venda não é rastreada ali e use o funil " +
  "como sinal de qualidade; 'none' = sem conversão, julgue por CPC/CPM. Nunca trate custo de " +
  "proxy barato como sucesso de negócio.";

/** Receita rastreada além do goal de negócio (§7 — não esconder). */
const REVENUE_TEXT =
  "Se a entidade trouxer 'revenue' (receita rastreada TOTAL, ex.: valor de compras), SEMPRE " +
  "mencione — mesmo quando o goal de negócio é conversa/lead (sem valor). Reporte a receita e o " +
  "ROAS de retorno (revenue/gasto) como CONTEXTO adicional, deixando claro que vem de compras " +
  "rastreadas (secundário ao objetivo principal, que segue medido pelo CPA do goal). NUNCA diga " +
  "que 'não há ROAS/receita' quando 'revenue' está preenchido — o objetivo não muda, mas o dono " +
  "precisa ver todo o retorno.";

/** Tiers + sinais + elegibilidade (Fatia 6c) — como o LLM deve ler e agir. */
const QUALITY_TEXT =
  "Cada entidade pode trazer 'tier' (winner/performer/underperformer/zombie), 'healthSignals' " +
  "(creative_fatigue = fadiga de criativo; audience_saturation = público saturado; low_volume = " +
  "pouco dado) e 'eligibility' (hasSignificance, inLearning). Aja assim: proteja os WINNERS (não " +
  "mexa no que vai bem), priorize PAUSAR os ZOMBIES (gasto sem conversão = desperdício), conserte os " +
  "UNDERPERFORMERS. NUNCA recomende ESCALAR (aumentar orçamento / reativar) uma entidade sem " +
  "hasSignificance ou em inLearning — nesse caso recomende investigar ou aguardar mais dados.";

/**
 * Atribuição × incrementalidade — freia recomendação de pausa por CPA atribuído.
 * O CPA/ROAS da Meta é ATRIBUÍDO (último clique/visualização numa janela), não medida de
 * INCREMENTALIDADE: subestima o valor de topo de funil (prospecção), que gera demanda
 * captada depois por remarketing/marca/direto (efeito halo). Nuança o "pausar" da QUALITY_TEXT.
 */
const INCREMENTALITY_TEXT =
  "Atribuição NÃO é incrementalidade: o CPA/ROAS que a Meta reporta é ATRIBUÍDO (último clique/" +
  "visualização dentro de uma janela) e SUBESTIMA o valor de campanhas de TOPO DE FUNIL " +
  "(prospecção/reconhecimento), que geram demanda captada depois por remarketing/marca/direto " +
  "(efeito halo). Isto rebaixa a AÇÃO, NUNCA a VISIBILIDADE: SEMPRE reporte o ponto de atenção " +
  "(CPA atribuído alto / baixo desempenho) como finding, com o caveat de atribuição, e deixe a " +
  "decisão de pausar com o dono — não omita nem minimize o achado. Antes de recomendar a AÇÃO de " +
  "PAUSAR: (1) não pause prospecção/aquisição só pelo CPA atribuído alto — ela alimenta as campanhas " +
  "de conversão; pausá-la pode secar o remarketing (pense no efeito na conta TODA, não na campanha " +
  "isolada); (2) reserve a PAUSA para ZUMBI real (gasto sem resultado em lugar nenhum), não para " +
  "underperformer que ainda pode ser incremental; (3) na dúvida, prefira 'investigate'/monitorar ou " +
  "ajustar orçamento em vez de pausar — mas explicando o achado, não escondendo. Pausa de campanha " +
  "ativa exige evidência clara de desperdício, não atribuição isolada.";

/**
 * Direção acionável-por-humano + conselho (S3). Só no MAPA (por-campanha): a COPY real
 * chega ao prompt nesse papel, e é lá que o analista dá direção concreta de criativo/
 * público e ACONSELHA escalar/criar (texto, o humano executa).
 */
const ADVICE_TEXT =
  "O briefing pode trazer a COPY real dos anúncios (bloco 'Copy real...'). Use-a para DIREÇÃO DE " +
  "CRIATIVO concreta (ex: 'seu ângulo campeão é prova social; teste uma variação com depoimento') " +
  "— actionType 'review_creative'. Para PÚBLICO, dê direção de teste (ampliar/estreitar/novo " +
  "lookalike) — actionType 'review_audience'. Você pode ACONSELHAR em texto (o humano executa, " +
  "você NÃO aplica): ESCALAR um vencedor com significância (subir orçamento / duplicar) ou CRIAR " +
  "uma campanha (ex: manutenção entre campanhas) — use actionType 'investigate' (próximo passo " +
  "claro) ou 'keep' (leitura estratégica). NUNCA proponha ação de plataforma para escalar/criar " +
  "(não são aplicáveis agora). Seja SELETIVO: só direções/insights materiais, priorizados por impacto.";

/** Diagnóstico por padrão de métrica (causa provável, não só sintoma) — squad. */
const DIAGNOSIS_TEXT =
  "Ao explicar um problema, aponte a CAUSA provável pelo padrão das métricas: CTR baixo → gancho/" +
  "criativo fraco ou segmentação errada; CTR ok mas pouca conversa/conversão → página/oferta ou " +
  "qualificação do lead; conversão ok mas CPA alto → lance/orçamento ou concorrência; alcance baixo " +
  "→ público estreito ou orçamento baixo; frequência alta + CTR caindo → fadiga de criativo (renove).";

/**
 * Peso na RECÊNCIA (foco nos resultados mais recentes). O briefing traz 'trends' (recente vs
 * anterior) e a janela do período; dentro dela, o que aconteceu nos ÚLTIMOS DIAS pesa mais que
 * a média antiga acumulada. Sem virar gatilho de ruído de 1 dia.
 */
const RECENCY_TEXT =
  "Dê MAIS PESO aos resultados RECENTES: use 'trends' (recente vs anterior) e a janela do período — " +
  "o desempenho dos últimos dias importa mais que a média acumulada. Uma entidade com boa média mas " +
  "PIORANDO nos últimos dias é risco (sinalize mesmo que o acumulado ainda pareça bom); uma que MELHOROU " +
  "recentemente merece o benefício da dúvida antes de cortar. Priorize achados e ações pela FOTO ATUAL + " +
  "direção recente, não só pelo acumulado do período. Mas NÃO reaja a um único dia (ruído): leia a " +
  "tendência dos últimos dias, não o pico/vale isolado, e prefira 'investigate' quando o recente for curto demais pra concluir.";

/** Referência de plataforma (cold-start) — direcional, nunca a meta. */
const BENCHMARK_TEXT =
  "Se uma entidade trouxer 'benchmarkRef' (cold-start: conta sem meta e sem histórico), trate-o só " +
  "como REFERÊNCIA DE MERCADO direcional — nunca como a meta do dono e nunca declare sucesso por ele. " +
  "Sempre convide o dono a definir a meta (CPA/ROAS/custo por conversa) pra uma leitura precisa.";

/**
 * Orçamento + realocação (S1 — fecha o bug do chat não saber informar orçamento por
 * campanha). CBO×ABO (decisão do plano) + faseamento e CPA marginal como critério de
 * até-onde-escalar (decisão 4 — sem os 3 cenários explícitos, ver ROADMAP).
 */
const BUDGET_TEXT =
  "Cada entidade pode trazer 'budget' (orçamento resolvido: diário ou vitalício), 'atBudgetCeiling' " +
  "(true = sem folga pra gastar mais sem subir o orçamento; false = tem folga; ausente = sem dado " +
  "de orçamento em lugar nenhum) e 'isCBO' (true = orçamento na PRÓPRIA campanha; false = por " +
  "conjunto/adset — ABO). Numa campanha ABO ('isCBO': false), qualquer mudança de orçamento é POR " +
  "CONJUNTO, não um número único da campanha — deixe isso claro na recomendação. Para realocar verba " +
  "entre campanhas: proponha em FASES (nunca mover tudo de uma vez — ex.: metade agora, avalie o " +
  "resultado antes de mover o resto) e use o CPA MARGINAL (o custo do ÚLTIMO incremento de orçamento, " +
  "não a média histórica) como critério de até onde vale escalar — pare de recomendar mais orçamento " +
  "ali quando o marginal estiver piorando, mesmo que a média ainda pareça boa.";

export const ANALYSIS_KNOWLEDGE_BLOCKS: readonly AnalysisKnowledgeBlock[] = [
  { key: "funnel", theme: "conversao", text: FUNNEL_TEXT, relevant: isAnalysisRole },
  { key: "mismatch", theme: "conversao", text: MISMATCH_TEXT, relevant: isAnalysisRole },
  { key: "revenue", theme: "conversao", text: REVENUE_TEXT, relevant: (ctx) => isMapOrSynthesis(ctx) && ctx.hasRevenue },
  { key: "quality", theme: "qualidade", text: QUALITY_TEXT, relevant: isAnalysisRole },
  { key: "incrementality", theme: "qualidade", text: INCREMENTALITY_TEXT, relevant: isAnalysisRole },
  { key: "recency", theme: "qualidade", text: RECENCY_TEXT, relevant: isAnalysisRole },
  { key: "diagnosis", theme: "qualidade", text: DIAGNOSIS_TEXT, relevant: isAnalysisRole },
  { key: "advice", theme: "criativo", text: ADVICE_TEXT, relevant: (ctx) => ctx.role === "map" },
  { key: "waste", theme: "desperdicio", text: WASTE_TEXT, relevant: (ctx) => ctx.role === "synthesis" && ctx.hasWaste },
  { key: "tracking", theme: "desperdicio", text: TRACKING_TEXT, relevant: (ctx) => ctx.role === "synthesis" && ctx.trackingSuspect },
  { key: "benchmark", theme: "benchmark", text: BENCHMARK_TEXT, relevant: (ctx) => isMapOrSynthesis(ctx) && ctx.hasBenchmarkRef },
  { key: "budget", theme: "orcamento", text: BUDGET_TEXT, relevant: (ctx) => isMapOrSynthesis(ctx) && ctx.hasBudgetData },
];

/** Contexto do REVISOR (G7) — nenhum bloco condicional se aplica (correção não reporta
 *  desperdício/receita/benchmark/orçamento novos); só os blocos-base de leitura de dado entram. */
export const REVIEW_KNOWLEDGE_CONTEXT: AnalysisKnowledgeContext = {
  role: "review",
  hasWaste: false,
  trackingSuspect: false,
  hasRevenue: false,
  hasBenchmarkRef: false,
  hasBudgetData: false,
};

function anyEntityHasRevenue(entities: readonly EntitySummary[]): boolean {
  return entities.some((e) => (e.metrics.revenue ?? 0) > 0);
}
function anyEntityHasBenchmarkRef(entities: readonly EntitySummary[]): boolean {
  return entities.some((e) => e.benchmarkRef != null);
}
function anyEntityHasBudgetData(entities: readonly EntitySummary[]): boolean {
  return entities.some((e) => e.budget != null || e.atBudgetCeiling !== undefined);
}

/** Contexto da SÍNTESE (reduce, nível conta) — a partir do `AccountBrief`. */
export function buildSynthesisKnowledgeContext(brief: AccountBrief): AnalysisKnowledgeContext {
  const allEntities = [...brief.segments.campaigns, ...brief.segments.adsets, ...brief.segments.ads];
  const waste = brief.waste;
  return {
    role: "synthesis",
    hasWaste: (waste?.wastedSpend ?? 0) > 0 || (waste?.pareto?.misallocated.length ?? 0) > 0,
    trackingSuspect: brief.trackingHealth?.suspect === true,
    hasRevenue: (brief.totals.revenue ?? 0) > 0 || anyEntityHasRevenue(allEntities),
    hasBenchmarkRef: anyEntityHasBenchmarkRef(allEntities),
    hasBudgetData: anyEntityHasBudgetData(allEntities),
  };
}

/** Contexto do MAPA (por-campanha) — a partir da árvore curada `CampaignUnit`. Desperdício/
 *  tracking são sinais de CONTA (não computados por campanha) — sempre `false` aqui. */
export function buildCampaignKnowledgeContext(unit: CampaignUnit): AnalysisKnowledgeContext {
  const entities = [unit.campaign, ...unit.adsets.flatMap((g) => [g.adset, ...g.notableAds])];
  return {
    role: "map",
    hasWaste: false,
    trackingSuspect: false,
    hasRevenue: anyEntityHasRevenue(entities),
    hasBenchmarkRef: anyEntityHasBenchmarkRef(entities),
    hasBudgetData: anyEntityHasBudgetData(entities),
  };
}

/** Filtra os blocos relevantes ao contexto (papel + dado real da conta). */
export function selectAnalysisKnowledge(ctx: AnalysisKnowledgeContext): readonly AnalysisKnowledgeBlock[] {
  return ANALYSIS_KNOWLEDGE_BLOCKS.filter((b) => b.relevant(ctx));
}

const THEME_ORDER: readonly AnalysisKnowledgeTheme[] = ["conversao", "qualidade", "criativo", "desperdicio", "orcamento", "benchmark"];
const THEME_LABEL_PT: Readonly<Record<AnalysisKnowledgeTheme, string>> = {
  conversao: "Conversão e honestidade de medição",
  qualidade: "Qualidade e priorização de ação",
  criativo: "Direção de criativo e público",
  desperdicio: "Desperdício e alocação de verba",
  orcamento: "Orçamento e realocação de verba",
  benchmark: "Referência de mercado",
};
const KNOWLEDGE_PREAMBLE =
  "Conhecimento de domínio de tráfego pago a aplicar nesta análise (agrupado por tema; só o que é relevante pra esta conta agora):";

/**
 * Monta o texto final (preâmbulo + seções por tema, ordem ESTÁVEL — favorece cache de
 * prompt do provider) a partir dos blocos relevantes ao contexto. "" quando nada relevante.
 */
export function buildAnalysisKnowledgeText(ctx: AnalysisKnowledgeContext): string {
  const blocks = selectAnalysisKnowledge(ctx);
  if (blocks.length === 0) return "";
  const byTheme = new Map<AnalysisKnowledgeTheme, string[]>();
  for (const b of blocks) {
    const list = byTheme.get(b.theme) ?? [];
    list.push(b.text);
    byTheme.set(b.theme, list);
  }
  const sections = THEME_ORDER.filter((t) => byTheme.has(t)).map((t) => `${THEME_LABEL_PT[t]}:\n${byTheme.get(t)!.join("\n")}`);
  return [KNOWLEDGE_PREAMBLE, ...sections].join("\n\n");
}
