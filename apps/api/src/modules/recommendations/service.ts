import { and, eq, sql } from "drizzle-orm";
import { agentMemory, agentRuns, recommendationFeedback, recommendations, type Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import { notFound } from "../../middleware/error-handler.js";
import type { FeedbackInput } from "./schema.js";

export interface RecommendationsDeps {
  readonly db: Database;
}

/** Texto curto da memória "rejeitado" (o que o dono vetou). */
function memoryContent(rec: { title: string; rationale: string | null }): string {
  return rec.rationale ? `${rec.title} — ${rec.rationale}` : rec.title;
}

/**
 * Slice de recomendações (3b): captura 👍/👎 no site. 👎 → memória "rejeitado"
 * (o agente para de repetir) + marca a recomendação como dispensada. Org-scoped.
 */
export function createRecommendationsService(deps: RecommendationsDeps) {
  async function feedback(
    orgId: OrgId,
    recommendationId: string,
    input: FeedbackInput,
  ): Promise<FeedbackOutputResult> {
    const [rec] = await deps.db
      .select({
        id: recommendations.id,
        runId: recommendations.runId,
        title: recommendations.title,
        rationale: recommendations.rationale,
      })
      .from(recommendations)
      .where(and(eq(recommendations.id, recommendationId), eq(recommendations.orgId, orgId)))
      .limit(1);
    if (!rec) throw notFound("Recomendação não encontrada.");

    await deps.db.insert(recommendationFeedback).values({
      recommendationId: rec.id,
      vote: input.vote,
      ...(input.note ? { note: input.note } : {}),
    });

    if (input.vote === "down") {
      await deps.db
        .update(recommendations)
        .set({ status: "dismissed", updatedAt: sql`now()` })
        .where(and(eq(recommendations.id, rec.id), eq(recommendations.orgId, orgId)));

      // memória "rejeitado" p/ o agente do run (loop barato — injetada no próximo brief).
      const [run] = await deps.db
        .select({ agentId: agentRuns.agentId })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, rec.runId), eq(agentRuns.orgId, orgId)))
        .limit(1);
      if (run) {
        await deps.db.insert(agentMemory).values({
          orgId,
          agentId: run.agentId,
          type: "rejected",
          content: memoryContent(rec),
          lifecycle: "active",
        });
      }
    }
    return { ok: true };
  }

  return { feedback };
}

type FeedbackOutputResult = { ok: true };
