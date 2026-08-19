// Helper compartilhado (lógica sensível de credencial — uma fonte só). Marca o
// token inválido na CONEXÃO dona da conta (recolar 1x recupera todas as contas
// dela); conta legada sem conexão cai no status da própria conta. Usado pelo
// insights-sync e pelo grafo de análise.
import { and, eq, sql } from "drizzle-orm";
import { adAccounts, platformConnections, type Database } from "@trafego/db";

export async function markConnectionTokenInvalid(
  db: Database,
  orgId: string,
  adAccountUuid: string,
): Promise<void> {
  const [account] = await db
    .select({ connectionId: adAccounts.connectionId })
    .from(adAccounts)
    .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)))
    .limit(1);
  if (account?.connectionId) {
    await db
      .update(platformConnections)
      .set({ tokenStatus: "invalid", updatedAt: sql`now()` })
      .where(and(eq(platformConnections.id, account.connectionId), eq(platformConnections.orgId, orgId)));
    return;
  }
  await db
    .update(adAccounts)
    .set({ tokenStatus: "invalid", updatedAt: sql`now()` })
    .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)));
}
