// Repositório da última análise por unidade (map-reduce incremental — 3b-2).
// Herança: unidades sem mudança material reusam o `unit_json` daqui. `analyzedAt`
// só avança quando a unidade é REALMENTE reanalisada (não no inherit) — assim o
// deep periódico dispara quando a mais antiga passa do intervalo.

import { eq, sql } from "drizzle-orm";
import { entityAnalyses, type Database } from "@trafego/db";
import type { EntityLevel, InsightMetrics, PerformanceTier } from "@trafego/shared";
import type { UnitAnalysis } from "@trafego/shared";

export interface LastEntityAnalysis {
  readonly unit: UnitAnalysis;
  readonly metrics: Partial<InsightMetrics>;
  readonly flags: string[];
  readonly tier: PerformanceTier | null;
  readonly analyzedAt: Date;
}

export interface SaveEntityAnalysis {
  readonly entityId: string;
  readonly entityLevel: EntityLevel;
  readonly entityName: string;
  readonly unit: UnitAnalysis;
  readonly metrics: Partial<InsightMetrics>;
  readonly flags: string[];
  /** tier de desempenho (6c) — persistido p/ o histórico. */
  readonly tier?: PerformanceTier;
}

export interface EntityAnalysesRepo {
  loadByAgent(agentId: string): Promise<Map<string, LastEntityAnalysis>>;
  saveMany(agentId: string, runId: string, entries: readonly SaveEntityAnalysis[]): Promise<void>;
}

export function createEntityAnalysesRepo(db: Database): EntityAnalysesRepo {
  return {
    async loadByAgent(agentId) {
      const rows = await db
        .select({
          entityId: entityAnalyses.entityId,
          unitJson: entityAnalyses.unitJson,
          metricsJson: entityAnalyses.metricsJson,
          flags: entityAnalyses.flags,
          tier: entityAnalyses.tier,
          analyzedAt: entityAnalyses.analyzedAt,
        })
        .from(entityAnalyses)
        .where(eq(entityAnalyses.agentId, agentId));
      const map = new Map<string, LastEntityAnalysis>();
      for (const r of rows) {
        map.set(r.entityId, {
          unit: r.unitJson as unknown as UnitAnalysis,
          metrics: r.metricsJson as Partial<InsightMetrics>,
          flags: r.flags,
          tier: (r.tier as PerformanceTier | null) ?? null,
          analyzedAt: r.analyzedAt,
        });
      }
      return map;
    },

    async saveMany(agentId, runId, entries) {
      if (entries.length === 0) return;
      // upsert por (agentId, entityId) — analyzedAt avança só nas reanalisadas.
      await db
        .insert(entityAnalyses)
        .values(
          entries.map((e) => ({
            agentId,
            entityId: e.entityId,
            entityLevel: e.entityLevel,
            entityName: e.entityName,
            runId,
            unitJson: e.unit as unknown as Record<string, unknown>,
            metricsJson: e.metrics as Record<string, unknown>,
            flags: e.flags,
            tier: e.tier ?? null,
            analyzedAt: sql`now()`,
          })),
        )
        .onConflictDoUpdate({
          target: [entityAnalyses.agentId, entityAnalyses.entityId],
          set: {
            entityLevel: sql`excluded.entity_level`,
            entityName: sql`excluded.entity_name`,
            runId: sql`excluded.run_id`,
            unitJson: sql`excluded.unit_json`,
            metricsJson: sql`excluded.metrics_json`,
            flags: sql`excluded.flags`,
            tier: sql`excluded.tier`,
            analyzedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
    },
  };
}
