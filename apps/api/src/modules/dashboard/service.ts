// Slice do Painel (6a): KPIs da conta AO VIVO (computados do insights_snapshots com
// core puro, sem LLM) + "atualizar agora" (força sync-only). Cross-conta (panorama) =
// 6a-4. Números crus ao vivo; grade/recomendações seguem por-análise (datadas).

import { and, between, eq, max } from "drizzle-orm";
import { adAccounts, agents, insightsSnapshots, type Database } from "@trafego/db";
import { computeLiveTotals, resolveWindows } from "@trafego/core";
import { buildInsightsSyncJob } from "@trafego/shared";
import type { AgentGoals, InsightRow, OrgId, StoredInsightMetrics } from "@trafego/shared";
import type { SchedulerPort } from "@trafego/shared/ports";
import { notFound } from "../../middleware/error-handler.js";
import type { LiveKpis, LiveMetricsOutput, RefreshDataOutput } from "./schema.js";

export interface DashboardDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
  readonly windowDays: number;
  readonly baselineDays: number;
  /** relógio injetável (casca) — `today` da janela. */
  readonly now: () => Date;
}

const KPI_KEYS = ["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "cpa", "roas"] as const;

export function createDashboardService(deps: DashboardDeps) {
  const todayIso = (): string => deps.now().toISOString().slice(0, 10);

  /** Reconstrói o InsightRow (metrics + conversões) do jsonb — igual ao worker. */
  function toRow(r: {
    entityLevel: InsightRow["level"];
    entityId: string;
    date: string | null;
    metricsJson: StoredInsightMetrics;
  }): InsightRow {
    return {
      entityId: r.entityId,
      level: r.entityLevel,
      ...(r.date ? { date: r.date } : {}),
      metrics: r.metricsJson.metrics,
      ...(r.metricsJson.conversions ? { conversions: r.metricsJson.conversions } : {}),
      ...(r.metricsJson.rawActions ? { rawActions: r.metricsJson.rawActions } : {}),
    };
  }

  return {
    /** KPIs ao vivo de UMA conta (org-scoped) + as-of. */
    async liveMetrics(orgId: OrgId, accountId: string): Promise<LiveMetricsOutput> {
      const [account] = await deps.db
        .select({ currency: adAccounts.currency })
        .from(adAccounts)
        .where(and(eq(adAccounts.id, accountId), eq(adAccounts.orgId, orgId)))
        .limit(1);
      if (!account) throw notFound("Conta não encontrada.");

      const [agent] = await deps.db
        .select({ goals: agents.goals })
        .from(agents)
        .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId)))
        .limit(1);
      const goals: AgentGoals = agent?.goals ?? {};

      const { window, baseline } = resolveWindows(todayIso(), deps.windowDays, deps.baselineDays);
      // 1 query cobrindo baseline+janela → split em memória (sem 2 round-trips).
      const snaps = await deps.db
        .select({
          entityLevel: insightsSnapshots.entityLevel,
          entityId: insightsSnapshots.entityId,
          date: insightsSnapshots.date,
          metricsJson: insightsSnapshots.metricsJson,
        })
        .from(insightsSnapshots)
        .where(
          and(
            eq(insightsSnapshots.orgId, orgId),
            eq(insightsSnapshots.adAccountId, accountId),
            between(insightsSnapshots.date, baseline.since, window.until),
          ),
        );

      const rows: InsightRow[] = [];
      const baselineRows: InsightRow[] = [];
      for (const s of snaps) {
        const row = toRow(s);
        (s.date && s.date >= window.since ? rows : baselineRows).push(row);
      }

      const totals = computeLiveTotals({ rows, baselineRows, goals });
      const [{ latest } = { latest: null }] = await deps.db
        .select({ latest: max(insightsSnapshots.updatedAt) })
        .from(insightsSnapshots)
        .where(and(eq(insightsSnapshots.orgId, orgId), eq(insightsSnapshots.adAccountId, accountId)));

      return {
        currency: account.currency,
        asOf: latest ? latest.toISOString() : null,
        window,
        totals: totals ? pickKpis(totals) : null,
      };
    },

    /**
     * "Atualizar agora" (6a): força um sync-only (ignora a porta de staleness — o
     * worker sincroniza sempre que roda). Org-scoped. Sem LLM.
     */
    async requestRefresh(orgId: OrgId, accountId: string): Promise<RefreshDataOutput> {
      const [account] = await deps.db
        .select({ id: adAccounts.id })
        .from(adAccounts)
        .where(and(eq(adAccounts.id, accountId), eq(adAccounts.orgId, orgId)))
        .limit(1);
      if (!account) throw notFound("Conta não encontrada.");
      await deps.scheduler.enqueue(buildInsightsSyncJob({ accountId, orgId, trigger: "manual" }));
      return { enqueued: true };
    },
  };
}

/** Projeta os totais (InsightMetrics & delta) no shape de saída (só os KPIs exibidos). */
function pickKpis(totals: { readonly delta: Partial<Record<string, number>> } & Record<string, unknown>): LiveKpis {
  const out: Record<string, number> = {};
  for (const k of KPI_KEYS) if (typeof totals[k] === "number") out[k] = totals[k] as number;
  const delta: Record<string, number> = {};
  for (const [k, v] of Object.entries(totals.delta ?? {})) if (typeof v === "number") delta[k] = v;
  // spend/impressions/clicks/ctr são base (sempre número em computeLiveTotals).
  return { ...out, delta } as unknown as LiveKpis;
}
