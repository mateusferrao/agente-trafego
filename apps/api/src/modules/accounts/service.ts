import type { AccessibleAccount as AdsAccount, OrgId } from "@trafego/shared/types";
import type { AdsPlatformPort, CredentialVaultPort } from "@trafego/shared/ports";
import type { AccountsRepo, AdAccountRow } from "./repo.js";
import type {
  AccessibleAccount,
  AdAccountOutput,
  ConnectTokenInput,
  SelectAccountInput,
} from "./schema.js";

export interface AccountsDeps {
  readonly repo: AccountsRepo;
  readonly adsPlatform: AdsPlatformPort;
  readonly vault: CredentialVaultPort;
}

/**
 * Slice de contas Meta. Cola token → lista contas acessíveis (a própria chamada
 * valida o token: inválido → `AdsPlatformError`) → cliente escolhe → persiste com
 * o token cifrado (AES-256-GCM). **Token-only** (sem app id/secret): a checagem de
 * escopos (`/debug_token`) é fast-follow. Erros de plataforma chegam como
 * `AdsPlatformError` e são mapeados no error-handler (casca desacoplada).
 */
export function createAccountsService(deps: AccountsDeps) {
  return {
    /** Valida o token (implícito) e devolve as contas acessíveis (não persiste ainda). */
    async connectToken(_orgId: OrgId, input: ConnectTokenInput): Promise<AccessibleAccount[]> {
      const accounts = await deps.adsPlatform.listAccessibleAccounts(input.token);
      return accounts.map(toAccessibleOutput);
    },

    /** Persiste a conta escolhida com o token cifrado (valida a posse na Meta). */
    async selectAccount(orgId: OrgId, input: SelectAccountInput): Promise<AdAccountOutput> {
      const account = await deps.adsPlatform.getAdAccount(input.token, input.adAccountId);
      const tokenCripto = deps.vault.encrypt(input.token);
      const row = await deps.repo.upsert(orgId, {
        metaBusinessId: account.businessId ?? null,
        adAccountId: account.id,
        name: account.name,
        currency: account.currency ?? null,
        tokenCripto,
      });
      return toOutput(row);
    },

    async list(orgId: OrgId): Promise<AdAccountOutput[]> {
      const rows = await deps.repo.listByOrg(orgId);
      return rows.map(toOutput);
    },
  };
}

/** Domínio (porta) → contrato do cliente (sem businessId, que é interno). */
function toAccessibleOutput(account: AdsAccount): AccessibleAccount {
  return {
    id: account.id,
    name: account.name,
    ...(account.currency ? { currency: account.currency } : {}),
  };
}

function toOutput(row: AdAccountRow): AdAccountOutput {
  return {
    id: row.id,
    adAccountId: row.adAccountId,
    name: row.name,
    currency: row.currency,
    tokenStatus: row.tokenStatus,
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
  };
}
