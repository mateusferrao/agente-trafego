// Builder ÚNICO da linha de agent_memory a partir de uma candidata de lição — usado pelos
// dois produtores (destilação/manual em repo.ts e calibração em outcome-repo.ts) p/ não
// divergirem nas colunas (§13 "3x → extrai"). Novo campo de aprendizado = 1 lugar só.

import { MEMORY_TYPE_BY_KIND, lessonKeyOf, type LessonCandidate } from "@trafego/core";

export interface LessonRowOpts {
  readonly orgId: string;
  readonly agentId: string;
  readonly content: string;
  /** tempo da evidência incorporada (dedup do tick). */
  readonly evidenceAt: Date;
  readonly sourceRunId?: string;
  readonly sourceRecommendationId?: string;
  /** proposta de limiar pendente (opt-in HITL) — só nos priors de conta que a merecem. */
  readonly proposedThresholdPatch?: Record<string, unknown>;
}

/** Monta o value-object de INSERT em agent_memory (lifecycle=active, não confirmada). */
export function buildLessonRow(candidate: LessonCandidate, opts: LessonRowOpts) {
  return {
    orgId: opts.orgId,
    agentId: opts.agentId,
    type: MEMORY_TYPE_BY_KIND[candidate.kind],
    content: opts.content,
    confidence: candidate.confidence,
    lifecycle: "active" as const,
    scope: candidate.key.scope,
    dimension: candidate.key.dimension,
    direction: candidate.key.direction,
    // padrão do detector — coluna + segmento da chave (dedup por padrão → N por dimensão).
    pattern: candidate.evidence.pattern,
    ...(candidate.key.subjectId ? { subjectId: candidate.key.subjectId } : {}),
    origin: candidate.origin,
    semanticKey: lessonKeyOf(candidate.key),
    confirmedByHuman: false,
    // reinforceCount já nasce = nº de evidências de suporte (S p/ prior de conta) — senão o prior
    // de conta insere com 0 e o PRÓXIMO tick sempre re-escreve 1x (S>0) sem suporte novo. (F-core-8)
    reinforceCount: candidate.evidence.occurrences,
    lastReinforcedAt: opts.evidenceAt,
    ...(opts.sourceRunId ? { sourceRunId: opts.sourceRunId } : {}),
    ...(opts.sourceRecommendationId ? { sourceRecommendationId: opts.sourceRecommendationId } : {}),
    ...(opts.proposedThresholdPatch ? { proposedThresholdPatch: opts.proposedThresholdPatch } : {}),
  };
}
