// Conhecimento de ESTRUTURA de campanha do squad (I3) — PURO e testável. Fonte única da
// estrutura recomendada por objetivo (teste/escala/isolado/teste de público) + a regra de
// Advantage por negócio. Reusado pela CRIAÇÃO (defaults + eco honesto), pelo PLANO (S2) e
// espelhado no prompt. INVARIANTE: tudo aqui é RECOMENDAÇÃO — a palavra final é do dono.

import type { BudgetMode, EntitySummary, HealthSignal } from "@trafego/shared";

/** Intenção de estrutura que o dono expressa (ou que o Roy infere da conversa). */
export type CampaignIntent = "test" | "scale" | "isolated_test" | "audience_test" | "create";

export interface StructureRecommendation {
  /** onde mora a verba: campanha (CBO) × conjunto (ABO). */
  readonly budgetMode: BudgetMode;
  /** nº de CONJUNTOS (1 por segmento no teste de público). */
  readonly adsets: number;
  /** nº de ANÚNCIOS por conjunto. */
  readonly ads: number;
  /** por que essa estrutura (pro eco honesto). */
  readonly rationale: string;
}

/** Defaults do playbook (const nomeadas — sem número mágico). */
const DEFAULT_TEST_ADS = 5;
const ISOLATED_ADS = 1;
const AUDIENCE_TEST_ADS = 1;
const DEFAULT_AUDIENCE_SEGMENTS = 3;
const MIN_AUDIENCE_SEGMENTS = 2;

export interface ResolveStructureOptions {
  /** nº de anúncios pedido (teste: 5 ou 10). */
  readonly ads?: number;
  /** nº de segmentos/públicos a testar (teste de público → nº de conjuntos). */
  readonly segments?: number;
}

/** Estrutura recomendada pra uma intenção (defaults do squad). RECOMENDAÇÃO — o dono sobrepõe. */
export function resolveStructure(intent: CampaignIntent, opts: ResolveStructureOptions = {}): StructureRecommendation {
  const ads = Math.max(1, Math.floor(opts.ads ?? DEFAULT_TEST_ADS));
  switch (intent) {
    case "isolated_test":
      return { budgetMode: "abo", adsets: 1, ads: ISOLATED_ADS, rationale: "teste isolado: 1 conjunto ABO com 1 anúncio pra ler a variável sem interferência." };
    case "audience_test": {
      const adsets = Math.max(MIN_AUDIENCE_SEGMENTS, Math.floor(opts.segments ?? DEFAULT_AUDIENCE_SEGMENTS));
      return { budgetMode: "cbo", adsets, ads: AUDIENCE_TEST_ADS, rationale: "teste de público: 1 conjunto por segmento (mesmo criativo) pra comparar só o público, orçamento único na campanha." };
    }
    case "scale":
      return { budgetMode: "cbo", adsets: 1, ads: DEFAULT_TEST_ADS, rationale: "escalar o vencedor: CBO com 1 conjunto, orçamento único na campanha." };
    case "test":
    case "create":
    default:
      return { budgetMode: "cbo", adsets: 1, ads, rationale: "teste: CBO com 1 conjunto e alguns anúncios, orçamento único que a Meta distribui." };
  }
}

/** Advantage (expansão de público + melhorias de criativo): recomenda LIGAR pra negócio amplo,
 *  DESLIGAR pra negócio LOCAL (que atende só uma região). RECOMENDAÇÃO — o dono decide. */
export function resolveAdvantage(opts: { readonly localBusiness: boolean }): boolean {
  return !opts.localBusiness;
}

/** Notação do squad campanha-conjunto-anúncio (sempre 1 campanha): "1-5-1", "1-1-5". */
export function structureNotation(rec: StructureRecommendation): string {
  return `1-${rec.adsets}-${rec.ads}`;
}

// ── Próximo passo proativo (S1) ────────────────────────────────────────────
// Fecha a análise/push com UM movimento de CRESCIMENTO (forward-looking) — distinto das
// recomendações CORRETIVAS (que consertam o que está errado): ele aponta o próximo salto
// (escalar / testar público / preparar criativo), destilando o mesmo método do squad que o
// `analysis-knowledge` (SCALE_METHOD_TEXT/CREATIVE_REFRESH_TEXT) usa na análise. PURO e
// testável; `null` quando não há movimento claro (degrada em silêncio). INVARIANTE: é
// RECOMENDAÇÃO — a palavra final é do dono; a linha convida, nunca força.

/** Movimento de crescimento escolhido pelo run. */
export type GrowthMove = "test_audience" | "scale_winner" | "refresh_creative";

/** Sinais mínimos do run (derivados do brief) que decidem o movimento. */
export interface NextStepContext {
  /** vencedor provado (significância) com FOLGA de público — candidato a escalar verba. */
  readonly hasScalableWinner: boolean;
  /** vencedor que já SATUROU o público atual — só cresce por público novo, não subindo verba. */
  readonly hasSaturatedWinner: boolean;
  /** criativo com sinais de desgaste MAS que AINDA ENTREGA (creative_aging) — preparar o sucessor. */
  readonly hasAgingCreative: boolean;
}

/**
 * Escolhe UM movimento por prioridade de alavanca: escalar um vencedor fresco é o maior salto;
 * saturado só cresce por público novo; criativo envelhecendo é preparar o próximo. `null` = sem
 * movimento claro.
 */
export function pickGrowthMove(ctx: NextStepContext): GrowthMove | null {
  if (ctx.hasScalableWinner) return "scale_winner";
  if (ctx.hasSaturatedWinner) return "test_audience";
  if (ctx.hasAgingCreative) return "refresh_creative";
  return null;
}

/** Texto de negócio (sem sigla crua, sem travessão dramático) por movimento. */
const GROWTH_MOVE_MESSAGE: Readonly<Record<GrowthMove, string>> = {
  scale_winner:
    "Pensando no próximo passo pra crescer: o vencedor tem espaço pra escalar. Dá pra subir o orçamento aos poucos, sem salto brusco, acompanhando o custo do último aumento pra não perder eficiência. Se quiser, a gente vê isso.",
  test_audience:
    "Pensando no próximo passo pra crescer: o vencedor já saturou o público atual, então o salto vem de testar públicos novos, um segmento por vez com o mesmo criativo, pra comparar só o público. Se quiser, a gente monta o teste.",
  refresh_creative:
    "Pensando no próximo passo pra crescer: o vencedor ainda entrega, mas começa a dar sinais de desgaste. Vale já deixar o próximo criativo pronto pra trocar sem perder ritmo quando ele cansar.",
};

/** Linha proativa de crescimento (1-2 linhas) pro fim do push; `null` quando não há movimento. */
export function nextStepSuggestion(ctx: NextStepContext): string | null {
  const move = pickGrowthMove(ctx);
  return move ? GROWTH_MOVE_MESSAGE[move] : null;
}

const hasSignal = (e: EntitySummary, sig: HealthSignal): boolean => (e.healthSignals ?? []).includes(sig);
const isProvenWinner = (e: EntitySummary): boolean =>
  e.tier === "winner" && e.eligibility?.hasSignificance === true && e.eligibility?.inLearning !== true;

/**
 * Deriva os sinais de crescimento do conjunto de entidades do run (todas as campanhas/conjuntos/
 * anúncios). Um winner que SATUROU o público não conta como escalável (só cresce por público novo).
 * Espelha o guard de escala do §7 (nunca escalar sem significância / em learning).
 */
export function nextStepContextFromEntities(entities: readonly EntitySummary[]): NextStepContext {
  let hasScalableWinner = false;
  let hasSaturatedWinner = false;
  let hasAgingCreative = false;
  for (const e of entities) {
    if (hasSignal(e, "creative_aging")) hasAgingCreative = true;
    if (isProvenWinner(e)) {
      if (hasSignal(e, "audience_saturation")) hasSaturatedWinner = true;
      else hasScalableWinner = true;
    }
  }
  return { hasScalableWinner, hasSaturatedWinner, hasAgingCreative };
}
