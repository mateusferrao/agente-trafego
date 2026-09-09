// Conhecimento de ESTRUTURA de campanha do squad (I3) — PURO e testável. Fonte única da
// estrutura recomendada por objetivo (teste/escala/isolado/teste de público) + a regra de
// Advantage por negócio. Reusado pela CRIAÇÃO (defaults + eco honesto), pelo PLANO (S2) e
// espelhado no prompt. INVARIANTE: tudo aqui é RECOMENDAÇÃO — a palavra final é do dono.

import type { BudgetMode } from "@trafego/shared";

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
