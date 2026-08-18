import { and, eq } from "drizzle-orm";
import { accessGrants, memberships, users, type Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { MeteringPort } from "@trafego/shared/ports";
import type { AccessStatusOutput, UsageSummaryOutput } from "./schema.js";

export interface BillingDeps {
  readonly db: Database;
  readonly metering: MeteringPort;
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
  };
}
