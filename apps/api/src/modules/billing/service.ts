import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  accessGrants,
  adAccounts,
  agentRuns,
  agents,
  memberships,
  usageEvents,
  users,
  type Database,
} from "@trafego/db";
import { resolveCostCapUsd } from "@trafego/core";
import type { OrgId } from "@trafego/shared/types";
import type { MeteringPort } from "@trafego/shared/ports";
import type { AccessStatusOutput, CostsOutput, UsageSummaryOutput } from "./schema.js";

export interface BillingDeps {
  readonly db: Database;
  readonly metering: MeteringPort;
  /** cap default global de custo LLM (env) — referência do "gasto vs cap". */
  readonly costCapUsd: number;
}

/** Bounds [start, end) UTC de um range inclusivo por dia (since..until = "YYYY-MM-DD"). */
function dayRangeBounds(since: string, until: string): { start: Date; end: Date } {
  const start = new Date(`${since}T00:00:00.000Z`);
  const end = new Date(`${until}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1); // until inclusivo
  return { start, end };
}

/**
 * Slice de billing (§11). MVP = gate de acesso (allowlist) + resumo de uso a
 * partir do MeteringPort. Sem Stripe no MVP (markup é fast-follow).
 */
export function createBillingService(deps: BillingDeps) {
  return {
    /** Status de acesso da org = grant do email do owner (default `pending`). */
    async accessStatus(orgId: OrgId): Promise<AccessStatusOutput> {
      const [row] = await deps.db
        .select({ status: accessGrants.status })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .innerJoin(accessGrants, eq(accessGrants.email, users.email))
        .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner")))
        // determinístico se a org tiver mais de um owner: o mais antigo.
        .orderBy(memberships.createdAt)
        .limit(1);
      return { status: row?.status ?? "pending" };
    },

    async usage(orgId: OrgId, period: string): Promise<UsageSummaryOutput> {
      const summary = await deps.metering.summarize(orgId, period);
      return {
        orgId: summary.orgId,
        period: summary.period,
        totalCostUsd: summary.totalCostUsd,
        byType: summary.byType,
      };
    },

    /**
     * Painel de custos do owner (economia unitária, 6b) num range por dia:
     * total + série diária (byDay) + por tipo + rollup por conta
     * (usage_events→agent_runs→agents→ad_accounts). Custo de chat (run_id null) não
     * mapeia a conta → vira `unattributedCostUsd`. Tudo org-scoped, range [start,end).
     */
    async costs(orgId: OrgId, since: string, until: string): Promise<CostsOutput> {
      const { start, end } = dayRangeBounds(since, until);
      const inRange = and(
        eq(usageEvents.orgId, orgId),
        gte(usageEvents.createdAt, start),
        lt(usageEvents.createdAt, end),
      );

      // por tipo (cobre TODAS as linhas) → também dá o total.
      const typeRows = await deps.db
        .select({ type: usageEvents.type, total: sql<string | null>`sum(${usageEvents.cost})` })
        .from(usageEvents)
        .where(inRange)
        .groupBy(usageEvents.type);
      const byType: Record<string, number> = {};
      let totalCostUsd = 0;
      for (const r of typeRows) {
        const cost = r.total === null ? 0 : Number(r.total);
        byType[r.type] = cost;
        totalCostUsd += cost;
      }

      // série diária (UTC) — usa o índice created_at. Só volta dias COM custo…
      const dayRows = await deps.db
        .select({
          date: sql<string>`to_char(${usageEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          total: sql<string | null>`sum(${usageEvents.cost})`,
        })
        .from(usageEvents)
        .where(inRange)
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      // …então densifica: TODO dia de since..until (0 onde não houve) → pontos alinham
      // com o eixo de datas e a curva mostra a forma real (§ série temporal).
      const dayMap = new Map(dayRows.map((r) => [r.date, r.total === null ? 0 : Number(r.total)]));
      const byDay: { date: string; costUsd: number }[] = [];
      for (const cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const key = cur.toISOString().slice(0, 10);
        byDay.push({ date: key, costUsd: dayMap.get(key) ?? 0 });
      }

      // por conta (só linhas com run→agente→conta; chat/run_id null cai no não-atribuído).
      const acctRows = await deps.db
        .select({
          accountId: adAccounts.id,
          accountName: adAccounts.name,
          total: sql<string | null>`sum(${usageEvents.cost})`,
        })
        .from(usageEvents)
        .innerJoin(agentRuns, eq(usageEvents.runId, agentRuns.id))
        .innerJoin(agents, eq(agentRuns.agentId, agents.id))
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(inRange)
        .groupBy(adAccounts.id, adAccounts.name);
      const byAccount = acctRows
        .map((r) => ({
          accountId: r.accountId,
          accountName: r.accountName,
          costUsd: r.total === null ? 0 : Number(r.total),
        }))
        .filter((r) => r.costUsd > 0)
        .sort((a, b) => b.costUsd - a.costUsd);

      const attributed = byAccount.reduce((sum, r) => sum + r.costUsd, 0);
      const unattributedCostUsd = Math.max(0, totalCostUsd - attributed);

      return {
        since,
        until,
        totalCostUsd,
        byDay,
        byType,
        byAccount,
        unattributedCostUsd,
        // cap default global (env); per-agente (guardrail_configs) = fast-follow.
        capUsd: resolveCostCapUsd(null, deps.costCapUsd),
      };
    },
  };
}
