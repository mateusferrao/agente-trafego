import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { AdsPlatformPort, CredentialVaultPort } from "@trafego/shared/ports";
import { badRequest } from "../../middleware/error-handler.js";
import type {
  AccessibleAccount,
  AdAccountOutput,
  ConnectTokenInput,
  SelectAccountInput,
} from "./schema.js";

export interface AccountsDeps {
  readonly db: Database;
  readonly adsPlatform: AdsPlatformPort;
  readonly vault: CredentialVaultPort;
}

/**
 * Slice de contas Meta. Cola token → valida via AdsPlatformPort → lista contas
 * acessíveis → cliente escolhe. Token guardado cripto (AES-256-GCM). Erro Meta
 * `code 190` → token inválido (marca token_status=invalid, pede recolar — §8/§9).
 */
export function createAccountsService(deps: AccountsDeps) {
  return {
    /** Valida o token e devolve as contas acessíveis (ainda não persiste seleção). */
    async connectToken(_orgId: OrgId, input: ConnectTokenInput): Promise<AccessibleAccount[]> {
      try {
        // TODO: opcional — cache do token cripto pendente até o cliente escolher.
        const accounts = await deps.adsPlatform.listAccessibleAccounts(input.token);
        return accounts;
      } catch (error) {
        // TODO: detectar Meta OAuthException code 190 no adapter e sinalizar aqui.
        if (isMetaInvalidToken(error)) {
          throw badRequest("Token Meta inválido ou expirado (code 190). Cole um novo.");
        }
        throw error;
      }
    },

    /** Persiste a conta escolhida com o token cifrado no vault. */
    async selectAccount(
      _orgId: OrgId,
      _token: string,
      _input: SelectAccountInput,
    ): Promise<AdAccountOutput> {
      // TODO: vault.encrypt(token) → insert ad_accounts(token_cripto, token_status='valid', ...) scoped por org.
      void deps.vault;
      void deps.db;
      throw new Error("TODO: implementar selectAccount");
    },

    async list(_orgId: OrgId): Promise<AdAccountOutput[]> {
      // TODO: select ad_accounts where org_id = orgId.
      return [];
    },
  };
}

/** Heurística stub p/ o erro 190 da Graph API. TODO: mover p/ o adapter Meta. */
function isMetaInvalidToken(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 190
  );
}
