import type { OrgId } from "@trafego/shared/types";
import type { AccountsRepo, AdAccountRow } from "./repo.js";
import type { AdAccountOutput } from "./schema.js";

export interface AccountsDeps {
  readonly repo: AccountsRepo;
}

/**
 * Slice de contas: listagem das contas sob gestão (status `active`) da org. O
 * onboarding (conectar sistema externo + escolher contas) mora em `connections`.
 */
export function createAccountsService(deps: AccountsDeps) {
  return {
    async list(orgId: OrgId): Promise<AdAccountOutput[]> {
      const rows = await deps.repo.listByOrg(orgId);
      return rows.map(toOutput);
    },
  };
}

function toOutput(row: AdAccountRow): AdAccountOutput {
  return {
    id: row.id,
    adAccountId: row.adAccountId,
    name: row.name,
    currency: row.currency,
    status: row.status,
    tokenStatus: row.tokenStatus,
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
    accountHealthStatus: row.accountHealthStatus,
  };
}
