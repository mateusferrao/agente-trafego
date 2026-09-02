// Repositório do aprendizado contínuo (casca org-scoped sobre agent_memory estendida +
// leitura do histórico por-run em agent_runs.metrics_snapshot). O core (@trafego/core
// learning) decide/calcula; aqui só há IO. A curadoria transacional (merge/decay/
// contradição) e a medição de outcome entram nas subfatias seguintes reusando este repo.

import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { adAccounts, agentMemory, agentRuns, agents, entityConfigSnapshots, type Database } from "@trafego/db";
import type { AdEntity, EntityConfigSnapshot, HealthSignal, PerformanceTier, RunCampaignCard, TrackingHealth, WasteReport } from "@trafego/shared";
import {
  decayCutoffs,
  LEARNING_MEMORY_TYPES,
  lessonKindFromMemoryType,
  type DecayConfig,
  type LessonCandidate,
  type RunLearningSnapshot,
  type StoredLesson,
} from "@trafego/core";
import { buildLessonRow } from "./lesson-row.js";

/** Agente elegível ao aprendizado: ativo, conta ativa e NÃO dormante (não aprende de conta parada). */
export interface LearnableAgent {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
}

// fonte única em @trafego/core (derivado de MEMORY_TYPE_BY_KIND) — sem repetir o literal (§13).
const LEARNING_TYPES = LEARNING_MEMORY_TYPES;

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
  /** Decaimento (curadoria anti-pilha): sem reforço → `active→stale→archived`. Um degrau
   *  por sweep (varre arquiváveis ANTES de rebaixar ativas). Global (sweep de manutenção,
   *  como o reaper). Só toca linhas de aprendizado (fact/past_action com chave). */
  applyDecaySweep(now: Date, cfg: DecayConfig): Promise<{ staled: number; archived: number }>;
  /** Snapshot da config (orçamento/status) das entidades no dia — upsert por (conta,entidade,dia).
   *  Escrito no `record` da análise; base p/ detectar mudança manual do gestor (S4). */
  saveEntityConfigSnapshots(input: SaveConfigInput): Promise<void>;
}

export interface SaveConfigInput {
  readonly orgId: string;
  readonly adAccountId: string;
  readonly date: string;
  readonly entities: readonly AdEntity[];
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
      // `evidenceAt` marca a evidência incorporada já na criação → o próximo tick sobre a
      // MESMA janela não reforça (dedup); só evidência mais nova conta.
      await db.insert(agentMemory).values(
        buildLessonRow(candidate, { orgId, agentId, content, evidenceAt, ...(sourceRunId ? { sourceRunId } : {}) }),
      );
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

    async applyDecaySweep(now, cfg) {
      const { staleBefore, archiveBefore } = decayCutoffs(now, cfg);
      // só linhas de aprendizado com chave (não toca o `rejected`/`objective` legado).
      // Lição CONFIRMADA pelo humano NUNCA decai — o dono endossou explicitamente.
      const learningRows = and(
        inArray(agentMemory.type, [...LEARNING_TYPES]),
        isNotNull(agentMemory.semanticKey),
        isNotNull(agentMemory.lastReinforcedAt),
        eq(agentMemory.confirmedByHuman, false),
      );
      // 1) arquiva as `stale` velhas ANTES de rebaixar ativas (um degrau por sweep).
      const archived = await db
        .update(agentMemory)
        .set({ lifecycle: "archived", updatedAt: sql`now()` })
        .where(and(learningRows, eq(agentMemory.lifecycle, "stale"), lt(agentMemory.lastReinforcedAt, archiveBefore)))
        .returning({ id: agentMemory.id });
      // 2) rebaixa `active` sem reforço além do prazo → `stale`.
      const staled = await db
        .update(agentMemory)
        .set({ lifecycle: "stale", updatedAt: sql`now()` })
        .where(and(learningRows, eq(agentMemory.lifecycle, "active"), lt(agentMemory.lastReinforcedAt, staleBefore)))
        .returning({ id: agentMemory.id });
      return { staled: staled.length, archived: archived.length };
    },

    async saveEntityConfigSnapshots({ orgId, adAccountId, date, entities }) {
      if (entities.length === 0) return;
      const rows = entities.map((e) => ({
        orgId,
        adAccountId,
        entityLevel: e.level,
        entityId: e.id,
        date,
        configJson: entityConfigOf(e),
      }));
      await db
        .insert(entityConfigSnapshots)
        .values(rows)
        .onConflictDoUpdate({
          target: [entityConfigSnapshots.adAccountId, entityConfigSnapshots.entityId, entityConfigSnapshots.date],
          set: { configJson: sql`excluded.config_json`, updatedAt: sql`now()` },
        });
    },
  };
}

/** Projeta a config aprendível de uma AdEntity (orçamento/status; unidade menor da moeda). */
function entityConfigOf(e: AdEntity): EntityConfigSnapshot {
  return {
    status: e.status,
    ...(typeof e.dailyBudget === "number" ? { dailyBudgetMinor: e.dailyBudget } : {}),
    ...(typeof e.lifetimeBudget === "number" ? { lifetimeBudgetMinor: e.lifetimeBudget } : {}),
  };
}

// ─── mapeamento snapshot → RunLearningSnapshot ─────────────────────────────

/** Mapeia um `agent_runs.metrics_snapshot` p/ o formato de aprendizado. Exportado p/ teste. */
export function snapshotToRunLearning(
  runId: string,
  at: Date,
  snapshot: Record<string, unknown> | null,
): RunLearningSnapshot {
  const cards = Array.isArray(snapshot?.campaigns) ? (snapshot.campaigns as RunCampaignCard[]) : [];
  const byId = new Map<string, { externalId: string; name: string; tier?: PerformanceTier; healthSignals?: readonly HealthSignal[] }>();
  for (const c of cards) {
    byId.set(c.externalId, {
      externalId: c.externalId,
      name: c.name ?? c.externalId,
      ...(c.tier ? { tier: c.tier as PerformanceTier } : {}),
      ...(c.healthSignals && c.healthSignals.length > 0 ? { healthSignals: c.healthSignals } : {}),
    });
  }
  // `waste.zombies` cobre o conjunto COMPLETO (não só as campanhas com análise profunda) —
  // é a fonte do desperdício CRÔNICO SILENCIOSO (campanha zumbi que nunca entra no top-N e
  // só é "resumida", logo ausente dos cards). Marca essas como zumbi p/ o detector observacional.
  const waste = snapshot?.waste as WasteReport | undefined;
  for (const z of waste?.zombies ?? []) {
    const existing = byId.get(z.id);
    if (existing) {
      if (!existing.tier) byId.set(z.id, { ...existing, tier: "zombie" });
    } else {
      byId.set(z.id, { externalId: z.id, name: z.name, tier: "zombie" });
    }
  }
  // trackingHealth só está presente no snapshot QUANDO suspeito (ver buildMetricsSnapshot).
  const trackingSuspect = (snapshot?.trackingHealth as TrackingHealth | undefined)?.suspect === true;
  return { runId, at: at.toISOString(), campaigns: [...byId.values()], trackingSuspect };
}

function rowToStoredLesson(row: typeof agentMemory.$inferSelect): StoredLesson {
  return {
    id: row.id,
    kind: lessonKindFromMemoryType(row.type),
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
