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
  /** alguma entidade usa lance agressivo (≠ lowest_cost) E a CONTA não tem conversões
   *  acumuladas suficientes pra justificar (S2) — sinal de CONTA, só synthesis. */
  readonly bidStrategyMismatch: boolean;
  /** `brief.demographics` presente (S7) — já filtrado por materialidade (`hasMaterialSpread`)
   *  antes de chegar aqui; a NOTE só decide se EXPLICA o campo, não se ele é relevante. */
  readonly hasDemographics: boolean;
  /** `brief.placements` presente (S7) — mesma regra de `hasDemographics`. */
  readonly hasPlacements: boolean;
}

/** Agrupamento temático (G2) — ordena a montagem do texto, não a lista de blocos.
 *  `segmentacao` (S7) é tema NOVO (não refinamento de tema existente) — breakdown
 *  demográfico/posicionamento é capacidade nova, não extensão de algo já coberto. */
export type AnalysisKnowledgeTheme =
  | "conversao"
  | "qualidade"
  | "criativo"
  | "desperdicio"
  | "orcamento"
  | "benchmark"
  | "segmentacao";

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
  "pouco dado; weak_creative = prova fraca + baixa densidade persuasiva no criativo, S4b — sinal " +
  "PURO de direção, use pra 'review_creative', nunca pra pausar/cortar orçamento sozinho; " +
  "weak_hook_retention = retenção de vídeo baixa nos primeiros ~25% (S6, o gancho falha na largada) " +
  "— mesma direção do weak_creative (review_creative, nunca guard de economia); " +
  "platform_quality_below_average = a própria Meta classifica o anúncio abaixo da média em " +
  "qualidade/engajamento/conversão (S6, opinião independente da plataforma) — trate como mais um " +
  "indício de criativo fraco, some com weak_creative/weak_hook_retention na mesma direção, nunca " +
  "sozinho como motivo de pausar) e 'eligibility' (hasSignificance, inLearning). Aja assim: proteja " +
  "os WINNERS (não mexa no que vai bem — winner com weak_creative é candidato a TESTAR uma " +
  "variação nova, não a pausar), priorize PAUSAR os ZOMBIES (gasto sem conversão = desperdício), " +
  "conserte os UNDERPERFORMERS. NUNCA recomende ESCALAR (aumentar orçamento / reativar) uma " +
  "entidade sem hasSignificance ou em inLearning — nesse caso recomende investigar ou aguardar " +
  "mais dados.";

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
 * público e ACONSELHA criar campanha (texto, o humano executa — criação ainda não é
 * ação de plataforma aplicável). ESCALAR orçamento, por outro lado, JÁ é ação de
 * plataforma de 1ª classe (actionType 'increase_budget'/'resume', com guardrail/
 * aprovação/guard de significância e teto de audiência — Fase 4): a decisão de
 * QUANTO escalar cabe à síntese (cross-campanha), mas o MAPA pode e deve PROPOR a
 * ação de escalar aqui quando a campanha for vencedora com significância — nunca
 * banir escalar do mapa (isso esterilizaria o insumo que a síntese precisa pra decidir).
 */
const ADVICE_TEXT =
  "O briefing pode trazer a COPY real dos anúncios (bloco 'Copy real...'). Use-a para DIREÇÃO DE " +
  "CRIATIVO concreta (ex: 'seu ângulo campeão é prova social; teste uma variação com depoimento') " +
  "— actionType 'review_creative'. Para PÚBLICO, dê direção de teste (ampliar/estreitar/novo " +
  "lookalike) — actionType 'review_audience'. Para ESCALAR um vencedor com significância (subir " +
  "orçamento), proponha a AÇÃO de plataforma de verdade (actionType 'increase_budget', seguindo o " +
  "faseamento/CPA-marginal do bloco de Orçamento quando presente) — a síntese decide a versão final " +
  "cross-campanha, mas o mapa não deve esconder a oportunidade. Para CRIAR uma campanha nova (ex: " +
  "manutenção entre campanhas), isso AINDA não é ação de plataforma aplicável — só ACONSELHE em " +
  "texto (o humano executa), com actionType 'investigate' (próximo passo claro) ou 'keep' (leitura " +
  "estratégica). Seja SELETIVO: só direções/insights materiais, priorizados por impacto.";

/**
 * Método de ESCALA (squad traffic-masters, `docs/referencia-traffic-masters.md` §1/§2) — COMO escalar
 * um vencedor, não só QUE escalar. Só na síntese (decisão cross-campanha de escala) + com dado de
 * orçamento. Complementa o BUDGET_TEXT (faseamento/CPA-marginal) com os 3 métodos + a trava de
 * maturidade e o teto por público (o mesmo teto que a ressalva de escala já calcula determinístico).
 */
const SCALE_METHOD_TEXT =
  "Ao propor ESCALAR um vencedor, escolha o MÉTODO pelo tamanho do salto pretendido (gap até a meta): " +
  "VERTICAL (salto < 2x) = subir o orçamento das campanhas atuais em passos graduais e espaçados (a " +
  "referência de mercado sugere ~20% a cada 48–72h), NUNCA tudo de uma vez — respeite o teto de mudança " +
  "de orçamento do guardrail; se o CPA subir >30% num passo, RECUE (a média esconde o problema — " +
  "olhe o CPA marginal do último incremento, não a média). HORIZONTAL (salto 2x–5x) = duplicar o " +
  "vencedor para PÚBLICOS novos (não só subir budget). DIAGONAL (5x+) = novos ângulos/plataformas. " +
  "Antes de escalar EXIJA maturidade: CPA abaixo da meta por ~5 dias seguidos e ~7–14 dias de dados; " +
  "nunca escale o não-provado, nem sem criativo novo pronto (escalar em criativo cansado queima verba). " +
  "Prefira o VERTICAL primeiro; horizontal quando o vertical der retorno decrescente. O TETO de escala " +
  "por público ≈ tamanho do público / (frequência × CPM) — não recomende escalar além do que o público " +
  "comporta (frequência de prospecção saudável fica perto de 2,5; acima de ~3 é sinal de saturação).";

/**
 * Cadência de refresh de criativo (squad, `docs/referencia-traffic-masters.md` §3) — QUANDO renovar.
 * No MAPA (onde a copy/criativo real chega). Complementa o DIAGNOSIS_TEXT (fadiga) com a cadência
 * concreta + o critério de 2+ sinais + "itera, não recomeça".
 */
const CREATIVE_REFRESH_TEXT =
  "Cadência de refresh de criativo: público pequeno pede criativo novo a cada ~5–7 dias; público " +
  "grande a cada ~14–21 dias. Recomende renovar/trocar o criativo quando 2+ sinais de fadiga " +
  "aparecerem juntos: CTR caindo >20% semana-a-semana, frequência acima de ~3, CPA subindo >30% do " +
  "baseline, engajamento em queda. NÃO recomece do zero — itere o gancho sobre os corpos que já " +
  "convertem, e tenha 2–3 criativos novos prontos ANTES de escalar um vencedor.";

/**
 * Scorecard de saúde de conta em 8 dimensões (squad, `docs/referencia-traffic-masters.md` §6) — uso
 * INTERNO de priorização (síntese), NÃO um output novo: o schema não muda; o `headline`/`biggestLeak`
 * já existentes lideram pela dimensão mais fraca. Ajuda o analista a não fixar num sintoma isolado.
 */
const SCORECARD_TEXT =
  "Antes de priorizar, avalie a conta MENTALMENTE em 8 dimensões (estrutura, público, criativo, " +
  "orçamento, lance, rastreamento, alinhamento de funil, desempenho) pra achar o MAIOR vazamento — a " +
  "dimensão mais fraca é o que mais move o resultado. Priorize a recomendação de topo por ela (o " +
  "resumo/headline lidera por esse gargalo). NÃO exponha um placar dimensão-a-dimensão nem invente " +
  "nota — é só uma lente de priorização; use os campos de saída que já existem.";

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

/** Maturidade de dado (squad Media Buyer) pra uma estratégia de lance agressiva fazer sentido
 *  — nº de conversões de negócio ACUMULADAS na conta. Abaixo disso, um cap/meta de lance é
 *  aposta cega (dado insuficiente pra calibrar). Gatilho do texto, não guard/guardrail — nunca
 *  bloqueia a conta de usar a estratégia, só orienta a recomendação. */
export const BID_STRATEGY_MATURITY_CONVERSIONS = 50;

/**
 * Estratégia de lance (S2, decisão 13) — fecha o gap de `bid_strategy` ser buscado e nunca
 * usado pra raciocínio. Só dispara quando a estratégia atual parece descasada da maturidade
 * de dado da conta (não é sempre-on — não teria ação nenhuma numa conta já madura).
 */
const BID_STRATEGY_TEXT =
  "Cada entidade pode trazer 'bidStrategy' ('lowest_cost' = padrão esperado, sem cap; " +
  "'bid_cap'/'cost_cap'/'min_roas' = lance com cap/meta explícita, com 'bidCapMajor' quando houver). " +
  `Uma estratégia com cap só faz sentido com a conta já tendo ~${BID_STRATEGY_MATURITY_CONVERSIONS} conversões de negócio ` +
  "acumuladas (dado suficiente pra calibrar o cap, não é aposta cega). Se a conta ainda não tem esse " +
  "volume E alguma entidade usa uma estratégia com cap, aponte o descasamento como achado e recomende " +
  "voltar para 'lowest_cost' até acumular mais dado — não é uma AÇÃO de plataforma (você não aplica), " +
  "é orientação em texto.";

/**
 * Breakdown demográfico/posicionamento (S7, pivô saúde — a alavanca #1 de saúde, antes
 * invisível). Já chega FILTRADO por materialidade (só spread acionável); a NOTE existe
 * pra orientar AÇÃO de baixo risco, nunca só constatar a diferença.
 */
const DEMOGRAPHICS_PLACEMENT_TEXT =
  "Se o briefing trouxer 'demographics' (idade+gênero) e/ou 'placements' (posicionamento), " +
  "cada um já foi filtrado por materialidade — só aparece quando o spread entre segmentos é " +
  "grande o bastante pra valer ação (nunca ruído estatístico). Cada segmento tem 'metrics' " +
  "(custo comparável) e um 'asOf' (data em que este breakdown foi sincronizado — CADÊNCIA " +
  "PRÓPRIA, mais lenta que o resto do dado; NUNCA trate como frescor do dia, sempre cite a " +
  "data quando mencionar o padrão). SEMPRE prescreva uma AÇÃO concreta de baixo risco a partir " +
  "do spread — nunca só constate a diferença: se um segmento (idade/gênero ou posicionamento) " +
  "custa muito mais que outro, recomende ABRIR a segmentação pro segmento barato (ex: incluir a " +
  "faixa etária que hoje está de fora) ou REDUZIR peso no segmento caro em favor do barato — " +
  "sem mexer no que já funciona. Use actionType 'review_audience' (idade/gênero, é público) ou " +
  "'investigate' (posicionamento, ainda não é uma ação de plataforma aplicável).";

export const ANALYSIS_KNOWLEDGE_BLOCKS: readonly AnalysisKnowledgeBlock[] = [
  { key: "funnel", theme: "conversao", text: FUNNEL_TEXT, relevant: isAnalysisRole },
  { key: "mismatch", theme: "conversao", text: MISMATCH_TEXT, relevant: isAnalysisRole },
  { key: "revenue", theme: "conversao", text: REVENUE_TEXT, relevant: (ctx) => isMapOrSynthesis(ctx) && ctx.hasRevenue },
  { key: "quality", theme: "qualidade", text: QUALITY_TEXT, relevant: isAnalysisRole },
  { key: "scorecard", theme: "qualidade", text: SCORECARD_TEXT, relevant: (ctx) => ctx.role === "synthesis" },
  { key: "incrementality", theme: "qualidade", text: INCREMENTALITY_TEXT, relevant: isAnalysisRole },
  { key: "recency", theme: "qualidade", text: RECENCY_TEXT, relevant: isAnalysisRole },
  { key: "diagnosis", theme: "qualidade", text: DIAGNOSIS_TEXT, relevant: isAnalysisRole },
  { key: "advice", theme: "criativo", text: ADVICE_TEXT, relevant: (ctx) => ctx.role === "map" },
  { key: "creative_refresh", theme: "criativo", text: CREATIVE_REFRESH_TEXT, relevant: (ctx) => ctx.role === "map" },
  { key: "scale_method", theme: "orcamento", text: SCALE_METHOD_TEXT, relevant: (ctx) => ctx.role === "synthesis" && ctx.hasBudgetData },
  { key: "waste", theme: "desperdicio", text: WASTE_TEXT, relevant: (ctx) => ctx.role === "synthesis" && ctx.hasWaste },
  { key: "tracking", theme: "desperdicio", text: TRACKING_TEXT, relevant: (ctx) => isMapOrSynthesis(ctx) && ctx.trackingSuspect },
  { key: "benchmark", theme: "benchmark", text: BENCHMARK_TEXT, relevant: (ctx) => isMapOrSynthesis(ctx) && ctx.hasBenchmarkRef },
  { key: "budget", theme: "orcamento", text: BUDGET_TEXT, relevant: (ctx) => isMapOrSynthesis(ctx) && ctx.hasBudgetData },
  { key: "bid_strategy", theme: "orcamento", text: BID_STRATEGY_TEXT, relevant: (ctx) => ctx.role === "synthesis" && ctx.bidStrategyMismatch },
  {
    key: "demographics_placement",
    theme: "segmentacao",
    text: DEMOGRAPHICS_PLACEMENT_TEXT,
    relevant: (ctx) => ctx.role === "synthesis" && (ctx.hasDemographics || ctx.hasPlacements),
  },
];

/** Contexto do REVISOR (G7) — nenhum bloco condicional se aplica (correção não reporta
 *  desperdício/receita/benchmark/orçamento/lance novos); só os blocos-base de leitura de dado entram. */
export const REVIEW_KNOWLEDGE_CONTEXT: AnalysisKnowledgeContext = {
  role: "review",
  hasWaste: false,
  trackingSuspect: false,
  hasRevenue: false,
  hasBenchmarkRef: false,
  hasBudgetData: false,
  bidStrategyMismatch: false,
  hasDemographics: false,
  hasPlacements: false,
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
function hasAggressiveBidStrategy(entities: readonly EntitySummary[]): boolean {
  return entities.some((e) => e.bidStrategy != null && e.bidStrategy !== "lowest_cost");
}

/**
 * Conversões de NEGÓCIO acumuladas (S2, maturidade de bid strategy) — soma só CAMPANHAS
 * com `conversionBasis === "target"` (a conversão de negócio É mensurável ali; soma por
 * CAMPANHA evita dupla-contagem entre níveis, já que account/campaign/adset/ad são
 * linhas de insight independentes na Meta, não uma soma dos filhos).
 *
 * NÃO usa `brief.totals.conversions`: esse total só resolve quando `goals.conversionGoal`
 * está configurado (override explícito) OU a entidade "account" teria objetivo próprio —
 * mas conta NÃO TEM objetivo (só campanha/adset/ad têm), então em qualquer conta ZERO-
 * CONFIG (o caminho default, CLAUDE.md §10) `totals.conversions` fica sempre undefined,
 * mesmo com milhares de conversões reais nas campanhas — faria este guard disparar
 * sempre, o oposto do pretendido.
 */
function businessConversionsAccumulated(campaigns: readonly EntitySummary[]): number {
  return campaigns.filter((c) => c.conversionBasis === "target").reduce((sum, c) => sum + (c.metrics.conversions ?? 0), 0);
}

/** Contexto da SÍNTESE (reduce, nível conta) — a partir do `AccountBrief`. */
export function buildSynthesisKnowledgeContext(brief: AccountBrief): AnalysisKnowledgeContext {
  const allEntities = [...brief.segments.campaigns, ...brief.segments.adsets, ...brief.segments.ads];
  const waste = brief.waste;
  const accountConversions = businessConversionsAccumulated(brief.segments.campaigns);
  return {
    role: "synthesis",
    hasWaste: (waste?.wastedSpend ?? 0) > 0 || (waste?.pareto?.misallocated.length ?? 0) > 0,
    trackingSuspect: brief.trackingHealth?.suspect === true,
    hasRevenue: (brief.totals.revenue ?? 0) > 0 || anyEntityHasRevenue(allEntities),
    hasBenchmarkRef: anyEntityHasBenchmarkRef(allEntities),
    hasBudgetData: anyEntityHasBudgetData(allEntities),
    bidStrategyMismatch: hasAggressiveBidStrategy(allEntities) && accountConversions < BID_STRATEGY_MATURITY_CONVERSIONS,
    hasDemographics: brief.demographics != null,
    hasPlacements: brief.placements != null,
  };
}

/** Contexto do MAPA (por-campanha) — a partir da árvore curada `CampaignUnit`. Desperdício/
 *  lance são sinais de CONTA (não computados por campanha) — sempre `false` aqui. `trackingSuspect`
 *  (S8) é a ÚNICA exceção: o caller repassa `brief.trackingHealth?.suspect` — a medição suspeita
 *  vale pra CADA campanha da conta (não é um agregado que só faz sentido na síntese), então o
 *  mapa também precisa do caveat ao propor pausar/cortar por CPA de venda. */
export function buildCampaignKnowledgeContext(unit: CampaignUnit, trackingSuspect = false): AnalysisKnowledgeContext {
  const entities = [unit.campaign, ...unit.adsets.flatMap((g) => [g.adset, ...g.notableAds])];
  return {
    role: "map",
    hasWaste: false,
    trackingSuspect,
    bidStrategyMismatch: false,
    hasRevenue: anyEntityHasRevenue(entities),
    hasBenchmarkRef: anyEntityHasBenchmarkRef(entities),
    hasBudgetData: anyEntityHasBudgetData(entities),
    // breakdown demográfico/posicionamento (S7) é sinal de CONTA hoje (fast-follow:
    // breakdown por-campanha no mapa, ver ROADMAP) — sempre `false` aqui.
    hasDemographics: false,
    hasPlacements: false,
  };
}

/** Filtra os blocos relevantes ao contexto (papel + dado real da conta). */
export function selectAnalysisKnowledge(ctx: AnalysisKnowledgeContext): readonly AnalysisKnowledgeBlock[] {
  return ANALYSIS_KNOWLEDGE_BLOCKS.filter((b) => b.relevant(ctx));
}

// Exportado só pra teste de invariante (achado da revisão): todo tema usado em algum bloco
// de ANALYSIS_KNOWLEDGE_BLOCKS precisa aparecer aqui, senão o bloco NUNCA sai no texto final
// mesmo com `relevant()` true — bug silencioso (THEME_LABEL_PT é `Record` exaustivo, o TS
// já pega esquecimento ali; este array não tem essa rede, por isso o teste).
export const THEME_ORDER: readonly AnalysisKnowledgeTheme[] = ["conversao", "qualidade", "criativo", "desperdicio", "orcamento", "segmentacao", "benchmark"];
const THEME_LABEL_PT: Readonly<Record<AnalysisKnowledgeTheme, string>> = {
  conversao: "Conversão e honestidade de medição",
  qualidade: "Qualidade e priorização de ação",
  criativo: "Direção de criativo e público",
  desperdicio: "Desperdício e alocação de verba",
  orcamento: "Orçamento e realocação de verba",
  segmentacao: "Segmentação por audiência e posicionamento",
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
