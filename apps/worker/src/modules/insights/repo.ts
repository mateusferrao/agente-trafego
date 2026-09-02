// Repositório de insights_snapshots (casca, org-scoped). Escrita idempotente por
// (ad_account_id, entity_id, date). Sem prune aqui — retenção/prune = Fatia 6b.

import { and, eq, gte, inArray, lte, max, sql } from "drizzle-orm";
import type { Database } from "@trafego/db/client";
import { insightsSnapshots } from "@trafego/db";
import type { EntityLevel, InsightRow, StoredInsightMetrics } from "@trafego/shared";

/** Linha a gravar (adAccountId = uuid de ad_accounts.id; entityId = id Meta). */
export interface SnapshotRow {
  readonly orgId: string;
  readonly adAccountId: string;
  readonly entityLevel: EntityLevel;
  readonly entityId: string;
  readonly date: string; // YYYY-MM-DD
  readonly metrics: StoredInsightMetrics;
}

export interface InsightsSnapshotsRepo {
  /** Última data já presente p/ (conta, nível) — watermark do sync incremental. */
  latestDate(orgId: string, adAccountId: string, level: EntityLevel): Promise<string | null>;
  /** Upsert idempotente (rebusca da janela de atribuição sobrescreve o dia). */
  upsertMany(rows: readonly SnapshotRow[]): Promise<void>;
  /** Lê a janela p/ montar o brief (reconstrói InsightRow do jsonb). */
  listWindow(orgId: string, adAccountId: string, since: string, until: string): Promise<InsightRow[]>;
  /**
   * A conta teve atividade (spend>0 OU impressions>0) no nível `account` desde `since`?
   * Predicado da dormância (mesmo critério do brief). Barato (só o nível account).
   */
  accountActivitySince(orgId: string, adAccountId: string, since: string): Promise<boolean>;
  /**
   * Última vez que sincronizamos (max `updated_at`) por conta = base do as-of e da
   * porta de frescura. Batch (sem N+1) — 1 query p/ N contas. Contas sem snapshot não
   * aparecem no mapa (→ `shouldSync` trata como null = precisa sync).
   */
  latestSyncedAtByAccounts(accountIds: readonly string[]): Promise<Map<string, Date>>;
}

export function createDrizzleInsightsSnapshotsRepo(db: Database): InsightsSnapshotsRepo {
  return {
    async latestDate(orgId, adAccountId, level) {
      const [row] = await db
        .select({ latest: max(insightsSnapshots.date) })
        .from(insightsSnapshots)
        .where(
          and(
            eq(insightsSnapshots.orgId, orgId),
            eq(insightsSnapshots.adAccountId, adAccountId),
            eq(insightsSnapshots.entityLevel, level),
          ),
        );
      return row?.latest ?? null;
    },

    async upsertMany(rows) {
      if (rows.length === 0) return;
      await db
        .insert(insightsSnapshots)
        .values(
          rows.map((r) => ({
            orgId: r.orgId,
            adAccountId: r.adAccountId,
            entityLevel: r.entityLevel,
            entityId: r.entityId,
            date: r.date,
            metricsJson: r.metrics,
          })),
        )
        .onConflictDoUpdate({
          target: [insightsSnapshots.adAccountId, insightsSnapshots.entityId, insightsSnapshots.date],
          set: { metricsJson: sql`excluded.metrics_json`, updatedAt: sql`now()` },
        });
    },

    async latestSyncedAtByAccounts(accountIds) {
      if (accountIds.length === 0) return new Map();
      const rows = await db
        .select({ accountId: insightsSnapshots.adAccountId, latest: max(insightsSnapshots.updatedAt) })
        .from(insightsSnapshots)
        .where(inArray(insightsSnapshots.adAccountId, [...accountIds]))
        .groupBy(insightsSnapshots.adAccountId);
      const map = new Map<string, Date>();
      for (const r of rows) if (r.latest) map.set(r.accountId, r.latest);
      return map;
    },

    async accountActivitySince(orgId, adAccountId, since) {
      const rows = await db
        .select({ metricsJson: insightsSnapshots.metricsJson })
        .from(insightsSnapshots)
        .where(
          and(
            eq(insightsSnapshots.orgId, orgId),
            eq(insightsSnapshots.adAccountId, adAccountId),
            eq(insightsSnapshots.entityLevel, "account"),
            gte(insightsSnapshots.date, since),
          ),
        );
      return rows.some((r) => {
        const m = r.metricsJson?.metrics ?? {};
        return (m.spend ?? 0) > 0 || (m.impressions ?? 0) > 0;
      });
    },

    async listWindow(orgId, adAccountId, since, until) {
      const rows = await db
        .select()
        .from(insightsSnapshots)
        .where(
          and(
            eq(insightsSnapshots.orgId, orgId),
            eq(insightsSnapshots.adAccountId, adAccountId),
            gte(insightsSnapshots.date, since),
            lte(insightsSnapshots.date, until),
          ),
        );
      return rows.map((r) => ({
        entityId: r.entityId,
        level: r.entityLevel,
        date: r.date,
        metrics: r.metricsJson.metrics,
        ...(r.metricsJson.conversions ? { conversions: r.metricsJson.conversions } : {}),
        ...(r.metricsJson.rawActions ? { rawActions: r.metricsJson.rawActions } : {}),
        ...(r.metricsJson.qualityRankings ? { qualityRankings: r.metricsJson.qualityRankings } : {}),
      }));
    },
  };
}
