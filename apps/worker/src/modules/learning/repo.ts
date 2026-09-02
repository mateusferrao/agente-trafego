// Repositório do aprendizado contínuo (casca org-scoped sobre agent_memory estendida +
// leitura do histórico por-run em agent_runs.metrics_snapshot). O core (@trafego/core
// learning) decide/calcula; aqui só há IO. A curadoria transacional (merge/decay/
// contradição) e a medição de outcome entram nas subfatias seguintes reusando este repo.

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { adAccounts, agentMemory, agentRuns, agents, type Database } from "@trafego/db";
import type { PerformanceTier, RunCampaignCard, TrackingHealth } from "@trafego/shared";
import {
  lessonKeyOf,
  type LessonCandidate,
  type LessonKind,
  type RunLearningSnapshot,
  type StoredLesson,
} from "@trafego/core";

/** Agente elegível ao aprendizado: ativo, conta ativa e NÃO dormante (não aprende de conta parada). */
export interface LearnableAgent {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
}

/** map memoryType ↔ LessonKind (fact↔fact; past_action↔calibration). */
const KIND_TO_TYPE: Record<LessonKind, "fact" | "past_action"> = { fact: "fact", calibration: "past_action" };
const LEARNING_TYPES = ["fact", "past_action"] as const;

function typeToKind(type: string): LessonKind {
  return type === "past_action" ? "calibration" : "fact";
}

export interface LearningRepo {
  listLearnableAgents(): Promise<LearnableAgent[]>;
  loadRunHistory(orgId: string, agentId: string, limit: number): Promise<RunLearningSnapshot[]>;
  loadActiveLessons(orgId: string, agentId: string): Promise<StoredLesson[]>;
  findLessonByKey(
    orgId: string,
    agentId: string,
    semanticKey: string,
  ): Promise<{ id: string; confidence: number | null; lastReinforcedAt: Date | null } | null>;
  insertLesson(input: InsertLessonInput): Promise<void>;
  /** Reforça: sobe confiança, incrementa contagem, marca o tempo da evidência e
   *  REATIVA a lição (stale→active) — um padrão reobservado volta a valer. */
  reinforceLesson(id: string, confidence: number, evidenceAt: Date): Promise<void>;
}

export interface InsertLessonInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly candidate: LessonCandidate;
  readonly content: string;
  /** tempo da evidência mais recente incorporada (o run mais novo da janela) — dedup do tick. */
  readonly evidenceAt: Date;
  readonly sourceRunId?: string;
}

export function createLearningRepo(db: Database): LearningRepo {
  return {
    async listLearnableAgents() {
      const rows = await db
        .select({ orgId: agents.orgId, agentId: agents.id, adAccountId: agents.adAccountId })
        .from(agents)
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(
          and(
            eq(agents.status, "active"),
            eq(adAccounts.status, "active"),
            eq(adAccounts.activityState, "active"),
          ),
        );
      return rows;
    },

    async loadRunHistory(orgId, agentId, limit) {
      const rows = await db
        .select({ id: agentRuns.id, at: agentRuns.createdAt, snapshot: agentRuns.metricsSnapshot })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, orgId),
            eq(agentRuns.agentId, agentId),
            inArray(agentRuns.status, ["succeeded", "partial"]),
            isNotNull(agentRuns.metricsSnapshot),
          ),
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(limit);
      // mais antigo → mais novo (o detector espera ordem cronológica).
      return rows.reverse().map((r) => snapshotToRunLearning(r.id, r.at, r.snapshot));
    },

    async loadActiveLessons(orgId, agentId) {
      const rows = await db
        .select()
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.orgId, orgId),
            eq(agentMemory.agentId, agentId),
            inArray(agentMemory.type, [...LEARNING_TYPES]),
            eq(agentMemory.lifecycle, "active"),
            isNotNull(agentMemory.semanticKey),
          ),
        );
      return rows.map(rowToStoredLesson);
    },

    async findLessonByKey(orgId, agentId, semanticKey) {
      const [row] = await db
        .select({ id: agentMemory.id, confidence: agentMemory.confidence, lastReinforcedAt: agentMemory.lastReinforcedAt })
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.orgId, orgId),
            eq(agentMemory.agentId, agentId),
            eq(agentMemory.semanticKey, semanticKey),
            sql`${agentMemory.lifecycle} <> 'archived'`,
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async insertLesson({ orgId, agentId, candidate, content, evidenceAt, sourceRunId }) {
      await db.insert(agentMemory).values({
        orgId,
        agentId,
        type: KIND_TO_TYPE[candidate.kind],
        content,
        confidence: candidate.confidence,
        lifecycle: "active",
        scope: candidate.key.scope,
        dimension: candidate.key.dimension,
        direction: candidate.key.direction,
        ...(candidate.key.subjectId ? { subjectId: candidate.key.subjectId } : {}),
        origin: candidate.origin,
        semanticKey: lessonKeyOf(candidate.key),
        confirmedByHuman: false,
        // marca a evidência incorporada já na criação → o próximo tick sobre a MESMA
        // janela não reforça (dedup); só evidência mais nova conta.
        lastReinforcedAt: evidenceAt,
        ...(sourceRunId ? { sourceRunId } : {}),
      });
    },

    async reinforceLesson(id, confidence, evidenceAt) {
      await db
        .update(agentMemory)
        .set({
          confidence,
          reinforceCount: sql`${agentMemory.reinforceCount} + 1`,
          lastReinforcedAt: evidenceAt,
          // padrão reobservado volta a valer (desfaz um stale do decay — S2).
          lifecycle: "active",
          updatedAt: sql`now()`,
        })
        .where(eq(agentMemory.id, id));
    },
  };
}

// ─── mapeamento snapshot → RunLearningSnapshot ─────────────────────────────

function snapshotToRunLearning(
  runId: string,
  at: Date,
  snapshot: Record<string, unknown> | null,
): RunLearningSnapshot {
  const campaigns = Array.isArray(snapshot?.campaigns) ? (snapshot.campaigns as RunCampaignCard[]) : [];
  // trackingHealth só está presente no snapshot QUANDO suspeito (ver buildMetricsSnapshot).
  const trackingSuspect = (snapshot?.trackingHealth as TrackingHealth | undefined)?.suspect === true;
  return {
    runId,
    at: at.toISOString(),
    campaigns: campaigns.map((c) => ({
      externalId: c.externalId,
      name: c.name ?? c.externalId,
      ...(c.tier ? { tier: c.tier as PerformanceTier } : {}),
      ...(c.healthSignals && c.healthSignals.length > 0 ? { healthSignals: c.healthSignals } : {}),
    })),
    trackingSuspect,
  };
}

function rowToStoredLesson(row: typeof agentMemory.$inferSelect): StoredLesson {
  return {
    id: row.id,
    kind: typeToKind(row.type),
    key: {
      scope: row.scope,
      dimension: row.dimension ?? "other",
      direction: row.direction ?? "neutral",
      ...(row.subjectId ? { subjectId: row.subjectId } : {}),
    },
    content: row.content,
    confidence: row.confidence ?? 0,
    confirmedByHuman: row.confirmedByHuman,
    origin: row.origin,
    lifecycle: row.lifecycle,
    reinforceCount: row.reinforceCount,
  };
}
