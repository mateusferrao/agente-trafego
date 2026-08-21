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

/** Início/fim (UTC) do período "YYYY-MM". */
function periodRange(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  const year = y ?? new Date().getUTCFullYear();
  const month = (m ?? 1) - 1;
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
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
     * Painel de custos do owner (economia unitária, 6b): total + por tipo (reusa
     * summarize) + rollup por conta (usage_events→agent_runs→agents→ad_accounts).
     * Custo de chat (run_id null) não mapeia a conta → vira `unattributedCostUsd`.
     */
    async costs(orgId: OrgId, period: string): Promise<CostsOutput> {
      const summary = await deps.metering.summarize(orgId, period);
      const { start, end } = periodRange(period);

      const rows = await deps.db
        .select({
          accountId: adAccounts.id,
          accountName: adAccounts.name,
          total: sql<string | null>`sum(${usageEvents.cost})`,
        })
        .from(usageEvents)
        .innerJoin(agentRuns, eq(usageEvents.runId, agentRuns.id))
        .innerJoin(agents, eq(agentRuns.agentId, agents.id))
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(
          and(
            eq(usageEvents.orgId, orgId),
            gte(usageEvents.createdAt, start),
            lt(usageEvents.createdAt, end),
          ),
        )
        .groupBy(adAccounts.id, adAccounts.name);

      const byAccount = rows
        .map((r) => ({
          accountId: r.accountId,
          accountName: r.accountName,
          costUsd: r.total === null ? 0 : Number(r.total),
        }))
        .filter((r) => r.costUsd > 0)
        .sort((a, b) => b.costUsd - a.costUsd);

      const attributed = byAccount.reduce((sum, r) => sum + r.costUsd, 0);
      // resto (chat/run_id null ou órfãos) — honesto: não força atribuição a conta.
      const unattributedCostUsd = Math.max(0, summary.totalCostUsd - attributed);

      return {
        period: summary.period,
        totalCostUsd: summary.totalCostUsd,
        byType: summary.byType,
        byAccount,
        unattributedCostUsd,
        // cap default global (env); per-agente (guardrail_configs) = fast-follow.
        capUsd: resolveCostCapUsd(null, deps.costCapUsd),
      };
    },
  };
}
