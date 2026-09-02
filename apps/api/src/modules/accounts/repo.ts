import { and, eq } from "drizzle-orm";
import { adAccounts, platformConnections, type Database } from "@trafego/db";

/** Status do token da conta (espelha o enum `token_status` do schema). */
export type AccountTokenStatus = "valid" | "invalid" | "unchecked";
/** Ciclo de vida da conta sob gestão (espelha `account_lifecycle`). */
export type AccountLifecycle = "active" | "unavailable" | "removed";

/** Projeção da conta usada pelo slice (sem o token cifrado — nunca sai do backend). */
export interface AdAccountRow {
  readonly id: string;
  readonly adAccountId: string;
  readonly name: string | null;
  readonly currency: string | null;
  readonly status: AccountLifecycle;
  /** Token status efetivo: o da conexão (fonte da verdade) ou o legado da conta. */
  readonly tokenStatus: AccountTokenStatus;
  readonly lastValidatedAt: Date | null;
  /** Status da conta NA META (neutro; null/"active" = ok) — banner de saúde no shell. */
  readonly accountHealthStatus: string | null;
}

/**
 * Persistência do slice de contas (tudo org-scoped — §12). Só leitura das contas
 * geridas; a escrita (conectar/selecionar) mora no slice `connections`.
 */
export interface AccountsRepo {
  listByOrg(orgId: string): Promise<AdAccountRow[]>;
}

export function createDrizzleAccountsRepo(db: Database): AccountsRepo {
  return {
    /**
     * Contas sob gestão (status `active`) da org. Token status efetivo = o da
     * conexão dona do token (fonte da verdade); cai no legado da conta se ainda
     * não houver conexão (contas pré-migração). Contas `unavailable`/`removed`
     * não aparecem em Contas (superfície de trabalho).
     */
    async listByOrg(orgId) {
      const rows = await db
        .select({
          id: adAccounts.id,
          adAccountId: adAccounts.adAccountId,
          name: adAccounts.name,
          currency: adAccounts.currency,
          status: adAccounts.status,
          accountTokenStatus: adAccounts.tokenStatus,
          accountValidatedAt: adAccounts.lastValidatedAt,
          metaAccountStatus: adAccounts.metaAccountStatus,
          connTokenStatus: platformConnections.tokenStatus,
          connValidatedAt: platformConnections.lastValidatedAt,
        })
        .from(adAccounts)
        // join reafirma a org na conexão (defense-in-depth no status do token).
        .leftJoin(
          platformConnections,
          and(
            eq(adAccounts.connectionId, platformConnections.id),
            eq(platformConnections.orgId, adAccounts.orgId),
          ),
        )
        .where(and(eq(adAccounts.orgId, orgId), eq(adAccounts.status, "active")));
      return rows.map((r) => ({
        id: r.id,
        adAccountId: r.adAccountId,
        name: r.name,
        currency: r.currency,
        status: r.status,
        tokenStatus: r.connTokenStatus ?? r.accountTokenStatus,
        lastValidatedAt: r.connValidatedAt ?? r.accountValidatedAt,
        accountHealthStatus: r.metaAccountStatus,
      }));
    },
  };
}
