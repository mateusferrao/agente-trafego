// Repositório de insights_breakdowns (casca, org-scoped). Cadência PRÓPRIA (mais lenta
// que insights_snapshots) — upsert por (conta, entidade, dimensão), só o mais recente
// sobrevive (nunca historiza por dia — o spread demográfico muda devagar).

import { and, eq, max, sql } from "drizzle-orm";
import type { Database } from "@trafego/db/client";
import { insightsBreakdowns } from "@trafego/db";
import type { BreakdownDimension, BreakdownSegment, EntityLevel } from "@trafego/shared";

export interface BreakdownRow {
  readonly orgId: string;
  readonly adAccountId: string;
  readonly entityLevel: EntityLevel;
  readonly entityId: string;
  readonly dimension: BreakdownDimension;
  readonly segments: readonly BreakdownSegment[];
  readonly date: string; // YYYY-MM-DD — carimbo de frescor explícito
}

export interface StoredBreakdown {
  readonly entityId: string;
  readonly entityLevel: EntityLevel;
  readonly dimension: BreakdownDimension;
  readonly segments: readonly BreakdownSegment[];
  readonly date: string;
}

export interface InsightsBreakdownsRepo {
  /** Upsert idempotente — 1 linha por (conta, entidade, dimensão). */
  upsertMany(rows: readonly BreakdownRow[]): Promise<void>;
  /** Última data sincronizada p/ (conta, dimensão) — watermark da cadência própria
   *  (representada pelo nível `account`; conta+campanhas sincronizam no mesmo ciclo). */
  latestDate(orgId: string, adAccountId: string, dimension: BreakdownDimension): Promise<string | null>;
  /** Lê todos os breakdowns já sincronizados da conta (p/ montar o brief). */
  listByAccount(orgId: string, adAccountId: string): Promise<readonly StoredBreakdown[]>;
}

export function createDrizzleInsightsBreakdownsRepo(db: Database): InsightsBreakdownsRepo {
  return {
    async upsertMany(rows) {
      if (rows.length === 0) return;
      await db
        .insert(insightsBreakdowns)
        .values(
          rows.map((r) => ({
            orgId: r.orgId,
            adAccountId: r.adAccountId,
            entityLevel: r.entityLevel,
            entityId: r.entityId,
            dimension: r.dimension,
            segments: r.segments,
            date: r.date,
          })),
        )
        .onConflictDoUpdate({
          target: [insightsBreakdowns.adAccountId, insightsBreakdowns.entityId, insightsBreakdowns.dimension],
          set: { segments: sql`excluded.segments`, date: sql`excluded.date`, updatedAt: sql`now()` },
        });
    },

    async latestDate(orgId, adAccountId, dimension) {
      const [row] = await db
        .select({ latest: max(insightsBreakdowns.date) })
        .from(insightsBreakdowns)
        .where(
          and(
            eq(insightsBreakdowns.orgId, orgId),
            eq(insightsBreakdowns.adAccountId, adAccountId),
            eq(insightsBreakdowns.entityLevel, "account"),
            eq(insightsBreakdowns.dimension, dimension),
          ),
        );
      return row?.latest ?? null;
    },

    async listByAccount(orgId, adAccountId) {
      const rows = await db
        .select()
        .from(insightsBreakdowns)
        .where(and(eq(insightsBreakdowns.orgId, orgId), eq(insightsBreakdowns.adAccountId, adAccountId)));
      return rows.map((r) => ({
        entityId: r.entityId,
        entityLevel: r.entityLevel,
        dimension: r.dimension,
        segments: r.segments,
        date: r.date,
      }));
    },
  };
}
