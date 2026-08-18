import { eq } from "drizzle-orm";
import { adAccounts, type Database } from "@trafego/db";
import type { EncryptedPayload } from "@trafego/shared";

/** Status do token da conta (espelha o enum `token_status` do schema). */
export type AccountTokenStatus = "valid" | "invalid" | "unchecked";

/** Projeção da conta usada pelo slice (sem o token cifrado — nunca sai do backend). */
export interface AdAccountRow {
  readonly id: string;
  readonly adAccountId: string;
  readonly name: string | null;
  readonly currency: string | null;
  readonly tokenStatus: AccountTokenStatus;
  readonly lastValidatedAt: Date | null;
}

/** Dados p/ conectar/recolar uma conta (token já cifrado pela casca). */
export interface UpsertAccountInput {
  readonly metaBusinessId: string | null;
  readonly adAccountId: string;
  readonly name: string | null;
  readonly currency: string | null;
  readonly tokenCripto: EncryptedPayload;
}

const ROW_COLUMNS = {
  id: adAccounts.id,
  adAccountId: adAccounts.adAccountId,
  name: adAccounts.name,
  currency: adAccounts.currency,
  tokenStatus: adAccounts.tokenStatus,
  lastValidatedAt: adAccounts.lastValidatedAt,
} as const;

/**
 * Persistência do slice de contas (tudo org-scoped — §12). Concentra as queries
 * de `ad_accounts`; o service depende só desta interface (não do Drizzle).
 */
export interface AccountsRepo {
  listByOrg(orgId: string): Promise<AdAccountRow[]>;
  /** Insere ou, se a conta já existe na org, atualiza o token (= "recolar"). Atômico. */
  upsert(orgId: string, input: UpsertAccountInput): Promise<AdAccountRow>;
}

export function createDrizzleAccountsRepo(db: Database): AccountsRepo {
  return {
    async listByOrg(orgId) {
      return db.select(ROW_COLUMNS).from(adAccounts).where(eq(adAccounts.orgId, orgId));
    },

    async upsert(orgId, input) {
      // Upsert atômico via unique(org_id, ad_account_id): "recolar" nunca duplica,
      // mesmo com /select concorrente (duplo-clique) — o DB é a rede de segurança.
      const now = new Date();
      const [row] = await db
        .insert(adAccounts)
        .values({
          orgId,
          adAccountId: input.adAccountId,
          metaBusinessId: input.metaBusinessId,
          name: input.name,
          currency: input.currency,
          tokenCripto: input.tokenCripto,
          tokenStatus: "valid",
          lastValidatedAt: now,
        })
        .onConflictDoUpdate({
          target: [adAccounts.orgId, adAccounts.adAccountId],
          set: {
            metaBusinessId: input.metaBusinessId,
            name: input.name,
            currency: input.currency,
            tokenCripto: input.tokenCripto,
            tokenStatus: "valid",
            lastValidatedAt: now,
            updatedAt: now,
          },
        })
        .returning(ROW_COLUMNS);
      if (!row) throw new Error("falha ao gravar ad_account");
      return row;
    },
  };
}
