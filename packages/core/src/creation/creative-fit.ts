// Motor de FIT de criativo (núcleo PURO, sem IO) — a elegibilidade determinística e BARATA que hoje
// falta na seleção: ordena os candidatos por quão bem CASAM com a campanha nova (estágio de público,
// grupo de objetivo, fadiga), em vez de só desempenho cru. NÃO recusa ninguém — REORDENA (a decisão
// final e a nota honesta ficam nas camadas de cima, §8). A casca deriva os sinais neutros (estágio via
// `meta-audience-map`, saúde via snapshot) e passa pra cá — o core não conhece vocabulário Meta.

import type { AudienceStage, ConversionGoal, HealthSignal } from "@trafego/shared";
import { isFatigued } from "../analysis-guards/index.js";
import { outcomeKindFor } from "../benchmarks/index.js";

/** Pesos do fit (nomeados — sem número mágico). Estágio pesa mais que objetivo; fadiga rebaixa forte
 *  (fecha o gap: hoje só o líder é protegido de fadiga, os secundários do pool não). */
export const CREATIVE_FIT_WEIGHTS = {
  stageMatch: 2,
  stageMismatch: -3,
  goalMatch: 1,
  goalMismatch: -1,
  fatigued: -4,
} as const;

/** Contexto da campanha NOVA (neutro — a casca deriva estágio/objetivo). */
export interface CreativeFitContext {
  /** estágio do público da campanha nova (prospecção × remarketing × desconhecido). */
  readonly campaignStage: AudienceStage;
  /** objetivo da campanha nova (agrupado internamente em conversa/lead/venda). */
  readonly goal: ConversionGoal | undefined;
}

/** Candidato a criativo com os sinais NEUTROS que o fit compara (a casca preenche do snapshot/visão). */
export interface CreativeFitCandidate {
  readonly id: string;
  /** estágio do público onde o criativo RODOU (do snapshot curado); undefined = desconhecido → neutro. */
  readonly originStage?: AudienceStage;
  /** objetivo pelo qual o criativo rodou; undefined = desconhecido → neutro. */
  readonly originGoal?: ConversionGoal;
  /** sinais de saúde do criativo/entidade (fadiga/aging); ausência = sem sinal → neutro. */
  readonly healthSignals?: readonly HealthSignal[];
}

/** Um candidato com o veredito determinístico do fit (mantém o candidato original em `candidate`). */
export interface RankedCreativeCandidate<T extends CreativeFitCandidate> {
  readonly candidate: T;
  readonly score: number;
  readonly stageMatch: boolean;
  readonly stageMismatch: boolean;
  readonly goalMismatch: boolean;
  readonly fatigued: boolean;
}

/** Estágios OPOSTOS de verdade (prospecção × remarketing) — `unknown` nunca é oposto (é neutro). */
export function isOppositeStage(a: AudienceStage, b: AudienceStage): boolean {
  return (a === "prospecting" && b === "remarketing") || (a === "remarketing" && b === "prospecting");
}

/** Avalia UM candidato contra o contexto da campanha nova (determinístico, puro). */
export function scoreCreativeFit<T extends CreativeFitCandidate>(candidate: T, ctx: CreativeFitContext): RankedCreativeCandidate<T> {
  const stageKnown = ctx.campaignStage !== "unknown" && candidate.originStage !== undefined && candidate.originStage !== "unknown";
  const stageMatch = stageKnown && candidate.originStage === ctx.campaignStage;
  const stageMismatch = stageKnown && isOppositeStage(ctx.campaignStage, candidate.originStage!);

  const campaignOutcome = outcomeKindFor(ctx.goal);
  const candidateOutcome = outcomeKindFor(candidate.originGoal);
  const goalKnown = campaignOutcome !== undefined && candidateOutcome !== undefined;
  const goalMatch = goalKnown && campaignOutcome === candidateOutcome;
  const goalMismatch = goalKnown && campaignOutcome !== candidateOutcome;

  const fatigued = isFatigued(candidate.healthSignals);

  const score =
    (stageMatch ? CREATIVE_FIT_WEIGHTS.stageMatch : 0) +
    (stageMismatch ? CREATIVE_FIT_WEIGHTS.stageMismatch : 0) +
    (goalMatch ? CREATIVE_FIT_WEIGHTS.goalMatch : 0) +
    (goalMismatch ? CREATIVE_FIT_WEIGHTS.goalMismatch : 0) +
    (fatigued ? CREATIVE_FIT_WEIGHTS.fatigued : 0);

  return { candidate, score, stageMatch, stageMismatch, goalMismatch, fatigued };
}

/** Ordena os candidatos por FIT (maior score primeiro). Sort ESTÁVEL: empate preserva a ordem de
 *  entrada — ou seja, o ranking de DESEMPENHO que a casca já aplicou vira o desempate natural
 *  ("entre os que combinam, o que performa melhor"). NÃO remove ninguém. PURO. */
export function orderCandidatesByFit<T extends CreativeFitCandidate>(
  candidates: readonly T[],
  ctx: CreativeFitContext,
): RankedCreativeCandidate<T>[] {
  return candidates
    .map((c, i) => ({ ranked: scoreCreativeFit(c, ctx), i }))
    .sort((a, b) => b.ranked.score - a.ranked.score || a.i - b.i)
    .map((x) => x.ranked);
}
