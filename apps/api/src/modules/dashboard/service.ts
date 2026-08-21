// Slice do Painel (6a): KPIs da conta AO VIVO (computados do insights_snapshots com
// core puro, sem LLM) + "atualizar agora" (força sync-only). Cross-conta (panorama) =
// 6a-4. Números crus ao vivo; grade/recomendações seguem por-análise (datadas).

import { and, between, count, desc, eq, inArray, max, ne, sql } from "drizzle-orm";
import {
  adAccounts,
  agentRuns,
  agentToolCalls,
  agents,
  approvals,
  insightsSnapshots,
  platformConnections,
  type Database,
} from "@trafego/db";
import { computeLiveTotals, resolveWindows } from "@trafego/core";
import { buildInsightsSyncJob, UNDO_BLOCKED_TOOL_KEY, UNDO_TOOL_KEY } from "@trafego/shared";
import type { AgentGoals, InsightRow, OrgId, StoredInsightMetrics } from "@trafego/shared";
import type { SchedulerPort } from "@trafego/shared/ports";
import { notFound } from "../../middleware/error-handler.js";
import type {
  ActivityEvent,
  DashboardOutput,
  LiveKpis,
  LiveMetricsOutput,
  PanoramaCard,
  RefreshDataOutput,
  WasteSummary,
} from "./schema.js";

/** Sem análise há mais que isso (conta ativa) → sinal de atenção. 2× cadência = fast-follow. */
const STALE_RUN_MS = 48 * 60 * 60 * 1000;
/** Feed compacto de atividade recente. */
const ACTIVITY_LIMIT = 20;
/** Desperdício vazio (0 contas / sem análise) — evita `null` na saída. */
const EMPTY_WASTE: WasteSummary = { totalWasted: 0, accounts: [] };

export interface DashboardDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
  readonly windowDays: number;
  readonly baselineDays: number;
  /** limite de frescura (min) — fonte única do `stale` (o web não hardcoda). */
  readonly freshThresholdMin: number;
  /** relógio injetável (casca) — `today` da janela. */
  readonly now: () => Date;
}

const KPI_KEYS = ["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "cpa", "roas"] as const;

export function createDashboardService(deps: DashboardDeps) {
  const todayIso = (): string => deps.now().toISOString().slice(0, 10);
  /** dado velho? (fonte única do threshold — o web usa este booleano, não hardcoda). */
  const isStale = (latest: Date | null): boolean =>
    !latest || deps.now().getTime() - latest.getTime() > deps.freshThresholdMin * 60_000;

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
        stale: isStale(latest),
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

    /** Painel gerencial cross-conta (6a-4): pendências + atenção + atividade + panorama. */
    async dashboard(orgId: OrgId): Promise<DashboardOutput> {
      const panorama = await buildPanorama(orgId);
      if (panorama.length === 0) {
        return { pendingCount: 0, attention: [], recentActivity: [], panorama: [], waste: EMPTY_WASTE };
      }
      const recentActivity = await recentActivityFeed(orgId);
      const waste = await buildWaste(orgId);
      // total de pendências = soma por conta (toda pendente pertence a uma conta gerida).
      const pendingCount = panorama.reduce((s, c) => s + c.pendingCount, 0);
      return {
        pendingCount,
        attention: panorama.filter((c) => c.reasons.length > 0),
        recentActivity,
        panorama,
        waste,
      };
    },

    /** Só o panorama por conta (cards de decisão) — reusado pela tela Contas (lista rica). */
    async panorama(orgId: OrgId): Promise<PanoramaCard[]> {
      return buildPanorama(orgId);
    },
  };

  /**
   * Cards de decisão por conta (grade datada + KPIs ao vivo + as-of + atenção),
   * ordenados por gasto desc. Compartilhado por `dashboard()` (Painel resume top-N)
   * e pelo endpoint de Contas (lista completa).
   */
  async function buildPanorama(orgId: OrgId): Promise<PanoramaCard[]> {
    // 1) contas sob gestão (agente + conta ativa) + token efetivo (conexão › legado).
    const accounts = await deps.db
      .select({
        accountId: agents.adAccountId,
        agentId: agents.id,
        agentPaused: sql<boolean>`${agents.status} <> 'active'`,
        name: adAccounts.name,
        currency: adAccounts.currency,
        goals: agents.goals,
        tokenStatus: sql<string>`coalesce(${platformConnections.tokenStatus}, ${adAccounts.tokenStatus}, 'unchecked')`,
      })
      .from(agents)
      .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
      .leftJoin(platformConnections, eq(adAccounts.connectionId, platformConnections.id))
      .where(and(eq(agents.orgId, orgId), eq(adAccounts.status, "active")));
    if (accounts.length === 0) return [];
    const accountIds = accounts.map((a) => a.accountId);

    // 2) última análise (grade + data) por agente — 1 query (DISTINCT ON).
    const latestRuns = await deps.db
      .selectDistinctOn([agentRuns.agentId], {
        agentId: agentRuns.agentId,
        grade: sql<string | null>`${agentRuns.metricsSnapshot} #>> '{scorecard,grade}'`,
        finishedAt: agentRuns.finishedAt,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "succeeded")))
      .orderBy(agentRuns.agentId, desc(agentRuns.finishedAt));
    const runByAgent = new Map(latestRuns.map((r) => [r.agentId, r]));

    // 3) pendências por conta (cross-conta).
    const pendingRows = await deps.db
      .select({ accountId: agents.adAccountId, c: count() })
      .from(approvals)
      .innerJoin(agents, eq(approvals.agentId, agents.id))
      .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
      .groupBy(agents.adAccountId);
    const pendingByAccount = new Map(pendingRows.map((r) => [r.accountId, Number(r.c)]));

    // 4) KPIs ao vivo por conta (1 query de snapshots p/ todas + as-of).
    const live = await liveTotalsBatch(orgId, accountIds, accounts);

    const now = deps.now().getTime();
    const cards: PanoramaCard[] = accounts.map((a) => {
      const run = runByAgent.get(a.agentId);
      const grade = run?.grade ?? null;
      const finishedAt = run?.finishedAt ?? null;
      const pendingCount = pendingByAccount.get(a.accountId) ?? 0;
      const l = live.get(a.accountId);
      const reasons: PanoramaCard["reasons"] = [];
      if (a.tokenStatus === "invalid") reasons.push("token_invalid");
      // "sem análise recente" só p/ agente ATIVO (pausado é esperado ficar parado).
      if (!a.agentPaused && (!finishedAt || now - finishedAt.getTime() > STALE_RUN_MS)) {
        reasons.push("no_recent_run");
      }
      if (grade === "C" || grade === "D") reasons.push("bad_grade");
      if (pendingCount > 0) reasons.push("pending");
      return {
        accountId: a.accountId,
        accountName: a.name ?? a.accountId,
        currency: a.currency,
        agentPaused: a.agentPaused,
        tokenStatus: a.tokenStatus,
        grade,
        gradeAsOf: finishedAt ? finishedAt.toISOString() : null,
        live: l?.totals ?? null,
        asOf: l?.asOf ?? null,
        stale: l?.stale ?? true,
        pendingCount,
        reasons,
      };
    });
    // ordena por gasto desc (Painel resume top-N por gasto; Contas mostra tudo ordenado).
    return cards.sort((a, b) => (b.live?.spend ?? -1) - (a.live?.spend ?? -1));
  }

  /** KPIs ao vivo em lote (1 query de snapshots p/ N contas — sem N+1) + as-of. */
  async function liveTotalsBatch(
      orgId: OrgId,
      accountIds: readonly string[],
      accounts: readonly { accountId: string; goals: AgentGoals | null }[],
    ): Promise<Map<string, { totals: LiveKpis | null; asOf: string | null; stale: boolean }>> {
      const { window, baseline } = resolveWindows(todayIso(), deps.windowDays, deps.baselineDays);
      const snaps = await deps.db
        .select({
          adAccountId: insightsSnapshots.adAccountId,
          entityLevel: insightsSnapshots.entityLevel,
          entityId: insightsSnapshots.entityId,
          date: insightsSnapshots.date,
          metricsJson: insightsSnapshots.metricsJson,
        })
        .from(insightsSnapshots)
        .where(
          and(
            eq(insightsSnapshots.orgId, orgId),
            inArray(insightsSnapshots.adAccountId, [...accountIds]),
            between(insightsSnapshots.date, baseline.since, window.until),
          ),
        );
      const asOfRows = await deps.db
        .select({ accountId: insightsSnapshots.adAccountId, latest: max(insightsSnapshots.updatedAt) })
        .from(insightsSnapshots)
        .where(and(eq(insightsSnapshots.orgId, orgId), inArray(insightsSnapshots.adAccountId, [...accountIds])))
        .groupBy(insightsSnapshots.adAccountId);
      const asOfByAccount = new Map(asOfRows.map((r) => [r.accountId, r.latest]));
      const goalsByAccount = new Map(accounts.map((a) => [a.accountId, a.goals ?? {}]));

      const byAccount = new Map<string, { rows: InsightRow[]; baselineRows: InsightRow[] }>();
      for (const id of accountIds) byAccount.set(id, { rows: [], baselineRows: [] });
      for (const s of snaps) {
        const bucket = byAccount.get(s.adAccountId);
        if (!bucket) continue;
        const row = toRow(s);
        (s.date && s.date >= window.since ? bucket.rows : bucket.baselineRows).push(row);
      }

      const out = new Map<string, { totals: LiveKpis | null; asOf: string | null; stale: boolean }>();
      for (const id of accountIds) {
        const b = byAccount.get(id)!;
        const totals = computeLiveTotals({ rows: b.rows, baselineRows: b.baselineRows, goals: goalsByAccount.get(id) ?? {} });
        const latest = asOfByAccount.get(id) ?? null;
        out.set(id, { totals: totals ? pickKpis(totals) : null, asOf: latest ? latest.toISOString() : null, stale: isStale(latest) });
      }
      return out;
  }

  /**
   * Desperdício cross-conta (§Bloco 2): o `waste.wastedSpend` da ÚLTIMA análise
   * finalizada de cada conta (mesma junção do panorama — última succeeded por
   * agente, via DISTINCT ON). Só contas que ainda queimam (> 0), maior primeiro.
   */
  async function buildWaste(orgId: OrgId): Promise<WasteSummary> {
    const rows = await deps.db
      .selectDistinctOn([agentRuns.agentId], {
        accountId: agents.adAccountId,
        accountName: adAccounts.name,
        wastedSpend: sql<string | null>`${agentRuns.metricsSnapshot} #>> '{waste,wastedSpend}'`,
      })
      .from(agentRuns)
      .innerJoin(agents, eq(agentRuns.agentId, agents.id))
      .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.status, "succeeded"),
          eq(adAccounts.status, "active"),
        ),
      )
      .orderBy(agentRuns.agentId, desc(agentRuns.finishedAt));

    const accounts = rows
      .map((r) => ({
        accountId: r.accountId,
        accountName: r.accountName ?? r.accountId,
        wastedSpend: r.wastedSpend === null ? 0 : Number(r.wastedSpend),
      }))
      .filter((a) => Number.isFinite(a.wastedSpend) && a.wastedSpend > 0)
      .sort((a, b) => b.wastedSpend - a.wastedSpend);
    const totalWasted = accounts.reduce((s, a) => s + a.wastedSpend, 0);
    return { totalWasted, accounts };
  }

  /** Feed compacto cross-conta de ações do agente (inclui chat via coalesce). */
  async function recentActivityFeed(orgId: OrgId): Promise<ActivityEvent[]> {
      const rows = await deps.db
        .select({
          id: agentToolCalls.id,
          toolKey: agentToolCalls.toolKey,
          args: agentToolCalls.args,
          runId: agentToolCalls.runId,
          at: agentToolCalls.createdAt,
          accountId: agents.adAccountId,
          accountName: adAccounts.name,
        })
        .from(agentToolCalls)
        .leftJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
        .innerJoin(agents, eq(agents.id, sql`coalesce(${agentToolCalls.agentId}, ${agentRuns.agentId})`))
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(and(eq(agents.orgId, orgId), ne(agentToolCalls.toolKey, UNDO_BLOCKED_TOOL_KEY)))
        .orderBy(desc(agentToolCalls.createdAt))
        .limit(ACTIVITY_LIMIT * 3);

      const events: ActivityEvent[] = [];
      for (const r of rows) {
        const args = r.args as { target?: { name?: string; id?: string }; dryRun?: boolean };
        if (args.dryRun === true) continue; // simulado não é mudança real
        events.push({
          id: r.id,
          accountId: r.accountId,
          accountName: r.accountName ?? r.accountId,
          type: r.toolKey === UNDO_TOOL_KEY ? "action_rolled_back" : "action_applied",
          toolKey: r.toolKey,
          entityName: args.target?.name ?? args.target?.id ?? null,
          at: r.at.toISOString(),
          fromChat: r.runId === null,
        });
        if (events.length >= ACTIVITY_LIMIT) break;
      }
      return events;
  }
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
