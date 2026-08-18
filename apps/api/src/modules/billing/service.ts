import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { MeteringPort } from "@trafego/shared/ports";
import type { BetaAccessOutput, UsageSummaryOutput } from "./schema.js";

export interface BillingDeps {
  readonly db: Database;
  readonly metering: MeteringPort;
}

/**
 * Slice de billing (§11). MVP = allowlist beta (gate de acesso) + resumo de
 * uso a partir do MeteringPort. Sem Stripe no MVP (markup é fast-follow).
 */
export function createBillingService(deps: BillingDeps) {
  return {
    async betaAccess(_orgId: OrgId): Promise<BetaAccessOutput> {
      // TODO: select beta_access.status where org_id = orgId (default 'pending').
      void deps.db;
      return { status: "pending" };
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
  };
}
