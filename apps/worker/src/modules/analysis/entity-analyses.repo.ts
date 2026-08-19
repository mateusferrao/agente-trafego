// Repositório da última análise por unidade (map-reduce incremental — 3b-2).
// Herança: unidades sem mudança material reusam o `unit_json` daqui. `analyzedAt`
// só avança quando a unidade é REALMENTE reanalisada (não no inherit) — assim o
// deep periódico dispara quando a mais antiga passa do intervalo.

import { eq, sql } from "drizzle-orm";
import { entityAnalyses, type Database } from "@trafego/db";
import type { InsightMetrics } from "@trafego/shared";
import type { UnitAnalysis } from "@trafego/shared";

export interface LastEntityAnalysis {
  readonly unit: UnitAnalysis;
  readonly metrics: Partial<InsightMetrics>;
  readonly flags: string[];
  readonly analyzedAt: Date;
}

export interface SaveEntityAnalysis {
  readonly entityId: string;
  readonly unit: UnitAnalysis;
  readonly metrics: Partial<InsightMetrics>;
  readonly flags: string[];
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
            runId,
            unitJson: e.unit as unknown as Record<string, unknown>,
            metricsJson: e.metrics as Record<string, unknown>,
            flags: e.flags,
            analyzedAt: sql`now()`,
          })),
        )
        .onConflictDoUpdate({
          target: [entityAnalyses.agentId, entityAnalyses.entityId],
          set: {
            runId: sql`excluded.run_id`,
            unitJson: sql`excluded.unit_json`,
            metricsJson: sql`excluded.metrics_json`,
            flags: sql`excluded.flags`,
            analyzedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
    },
  };
}
