import type {
  ConversionBasis,
  ConversionGoal,
  ConversionProxy,
  EntityObjective,
  InsightMetrics,
} from "@trafego/shared";

// Resolução PURA de "qual conversão conta" para CPA/ROAS de uma entidade.
// Único ponto onde vive a precedência: override do agente (personalização,
// Fatia 4) vence o objetivo que o usuário já configurou na plataforma. Só fala
// o vocabulário genérico — o mapeamento específico de plataforma vive no adapter.

/** A conversão a contar (goal + id da personalizada, quando for o caso). */
export interface ResolvedConversion {
  readonly goal: ConversionGoal;
  readonly customConversionId?: string;
}

/**
 * `null` quando não há conversão definida (ex: entidade otimizando cliques) —
 * nesse caso a análise julga por CPC/CPM, não por CPA.
 */
export function resolveConversion(
  objective: EntityObjective | undefined,
  override?: ResolvedConversion,
): ResolvedConversion | null {
  if (override) return override;
  if (objective) {
    return {
      goal: objective.goal,
      ...(objective.customConversionId ? { customConversionId: objective.customConversionId } : {}),
    };
  }
  return null;
}

/**
 * Classifica a base de medição de uma entidade vs a conversão de NEGÓCIO do agente
 * (§7 — honestidade do descasamento). PURA e sem dependência do brief (evita ciclo):
 * recebe as métricas já derivadas.
 *  - `target`: a CPA de negócio É mensurável aqui (compara com a meta).
 *  - `proxy`: negócio não mensurável, mas o objetivo próprio da entidade é →
 *    expõe o custo do objetivo (rotulável), NUNCA declara meta batida.
 *  - `none`: sem conversão mensurável → julga por CPC/CPM.
 *
 * Fonte única desta classificação (reusada por `brief` e `playbook`).
 */
// Substantivo PT do "custo por X" (perspectiva do vendedor — CPA). Distinto do
// rótulo genérico da conversão (ex: purchase = "venda" aqui, "compra" no eco de
// config). Fonte única do rótulo de CPA exibido ao dono (conta + cards).
const CPA_NOUN_PT: Partial<Record<ConversionGoal, string>> = {
  purchase: "venda",
  lead: "lead",
  registration: "cadastro",
  initiate_checkout: "checkout",
  add_to_cart: "carrinho",
  view_content: "visualização",
  add_payment_info: "pagamento",
  search: "busca",
  contact: "contato",
  subscribe: "inscrição",
  start_trial: "teste",
  submit_application: "inscrição",
  messaging_started: "conversa",
  app_install: "instalação",
  custom: "resultado",
};

/**
 * Rótulo do KPI de custo-por-conversão exibido ao dono. Deriva do `conversionGoal`
 * de NEGÓCIO (ex: "Custo por venda"); sem goal mensurável → "Custo por resultado"
 * (genérico e honesto). Corrige o "Custo por venda" hardcoded do site. PURO.
 */
export function cpaLabelFor(goal: ConversionGoal | null | undefined): string {
  const noun = goal ? CPA_NOUN_PT[goal] : undefined;
  return `Custo por ${noun ?? "resultado"}`;
}

/** Substantivo PT do objetivo (ex: purchase → "venda") p/ nomear entidades — fonte única. */
export function goalNounPt(goal: ConversionGoal | null | undefined): string {
  return (goal ? CPA_NOUN_PT[goal] : undefined) ?? "resultado";
}

export function classifyBasis(params: {
  /** métricas com a conversão de negócio aplicada (override vence). */
  readonly businessMetrics: InsightMetrics;
  readonly hasOverride: boolean;
  readonly objective?: EntityObjective;
  /** métricas do objetivo próprio da entidade (sem override) — só p/ o proxy. */
  readonly proxyMetrics?: InsightMetrics;
}): { basis: ConversionBasis; proxy?: ConversionProxy } {
  const { businessMetrics, hasOverride, objective, proxyMetrics } = params;
  if (businessMetrics.cpa !== undefined) return { basis: "target" };
  if (hasOverride && objective && proxyMetrics?.cpa !== undefined) {
    const proxy: ConversionProxy = {
      goal: objective.goal,
      ...(objective.customConversionId ? { customConversionId: objective.customConversionId } : {}),
      cpa: proxyMetrics.cpa,
      ...(proxyMetrics.roas !== undefined ? { roas: proxyMetrics.roas } : {}),
    };
    return { basis: "proxy", proxy };
  }
  return { basis: "none" };
}
