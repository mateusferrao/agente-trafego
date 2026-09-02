// Repositório da última análise por unidade (map-reduce incremental — 3b-2).
// Herança: unidades sem mudança material reusam o `unit_json` daqui. `analyzedAt`
// só avança quando a unidade é REALMENTE reanalisada (não no inherit) — assim o
// deep periódico dispara quando a mais antiga passa do intervalo.

import { and, eq, inArray, sql } from "drizzle-orm";
import { entityAnalyses, type Database } from "@trafego/db";
import type { CuratedEntitySnapshot, EntityLevel, InsightMetrics, PerformanceTier } from "@trafego/shared";
import type { UnitAnalysis } from "@trafego/shared";

export interface LastEntityAnalysis {
  readonly unit: UnitAnalysis;
  readonly metrics: Partial<InsightMetrics>;
  readonly flags: string[];
  readonly tier: PerformanceTier | null;
  /** snapshot curado (S1) — null nas linhas de antes desta fase (backfill não retroativo). */
  readonly curated: CuratedEntitySnapshot | null;
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
  /** snapshot curado (S1) — budget/audience/funil/basis/healthSignals/eligibility. */
  readonly curated?: CuratedEntitySnapshot;
}

export interface EntityAnalysesRepo {
  loadByAgent(agentId: string): Promise<Map<string, LastEntityAnalysis>>;
  saveMany(agentId: string, runId: string, entries: readonly SaveEntityAnalysis[]): Promise<void>;
  /** Ids de CAMPANHA já cacheados pro agente (qualquer análise anterior) — base pra
   *  detectar quem saiu do conjunto ativo (sincronização, achado real). */
  loadCampaignIds(agentId: string): Promise<Set<string>>;
  /**
   * Marca `curatedJson.deactivatedSince` (ISO) nas campanhas que saíram do conjunto ativo —
   * só nas que AINDA não têm o campo (nunca sobrescreve a 1ª detecção; preserva "desde
   * quando"). No-op se `entityIds` vazio. Reativação se autocorrige sozinha: quando a
   * campanha volta a ativar e é reanalisada, `saveMany` reconstrói `curatedJson` do zero
   * (sem este campo) — não precisa "desmarcar" aqui.
   */
  markDeactivated(agentId: string, entityIds: readonly string[], deactivatedAt: Date): Promise<void>;
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
          curatedJson: entityAnalyses.curatedJson,
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
          curated: r.curatedJson ?? null,
          analyzedAt: r.analyzedAt,
        });
      }
      return map;
    },

    async loadCampaignIds(agentId) {
      const rows = await db
        .select({ entityId: entityAnalyses.entityId })
        .from(entityAnalyses)
        .where(and(eq(entityAnalyses.agentId, agentId), eq(entityAnalyses.entityLevel, "campaign")));
      return new Set(rows.map((r) => r.entityId));
    },

    async markDeactivated(agentId, entityIds, deactivatedAt) {
      if (entityIds.length === 0) return;
      await db
        .update(entityAnalyses)
        .set({
          // merge JSONB — preserva o resto do curated_json já gravado; nunca sobrescreve
          // uma detecção anterior (o WHERE abaixo só pega linhas ainda sem o campo).
          curatedJson: sql`coalesce(${entityAnalyses.curatedJson}, '{}'::jsonb) || jsonb_build_object('deactivatedSince', ${deactivatedAt.toISOString()}::text)`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(entityAnalyses.agentId, agentId),
            inArray(entityAnalyses.entityId, [...entityIds]),
            sql`(${entityAnalyses.curatedJson} ->> 'deactivatedSince') IS NULL`,
          ),
        );
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
            curatedJson: e.curated ?? null,
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
            curatedJson: sql`excluded.curated_json`,
            analyzedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
    },
  };
}
