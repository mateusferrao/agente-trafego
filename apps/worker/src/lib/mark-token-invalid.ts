// Helper compartilhado (lógica sensível de credencial — uma fonte só). Marca o
// token inválido na CONEXÃO dona da conta (recolar 1x recupera todas as contas
// dela); conta legada sem conexão cai no status da própria conta. Usado pelo
// insights-sync e pelo grafo de análise.
import { and, eq, sql } from "drizzle-orm";
import { adAccounts, platformConnections, type Database } from "@trafego/db";

/** `wasNewTransition` = true quando o token ESTAVA válido/não-checado e passou a
 *  inválido agora (achado da fatia de saúde de conta: sinaliza pro `insights-sync`
 *  disparar o alerta imediato só na transição, nunca redisparar em todo sync). */
export async function markConnectionTokenInvalid(
  db: Database,
  orgId: string,
  adAccountUuid: string,
): Promise<{ readonly wasNewTransition: boolean }> {
  const [account] = await db
    .select({ connectionId: adAccounts.connectionId })
    .from(adAccounts)
    .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)))
    .limit(1);
  if (account?.connectionId) {
    const [prevConn] = await db
      .select({ tokenStatus: platformConnections.tokenStatus })
      .from(platformConnections)
      .where(and(eq(platformConnections.id, account.connectionId), eq(platformConnections.orgId, orgId)))
      .limit(1);
    await db
      .update(platformConnections)
      .set({ tokenStatus: "invalid", updatedAt: sql`now()` })
      .where(and(eq(platformConnections.id, account.connectionId), eq(platformConnections.orgId, orgId)));
    return { wasNewTransition: prevConn?.tokenStatus !== "invalid" };
  }
  const [prevAccount] = await db
    .select({ tokenStatus: adAccounts.tokenStatus })
    .from(adAccounts)
    .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)))
    .limit(1);
  await db
    .update(adAccounts)
    .set({ tokenStatus: "invalid", updatedAt: sql`now()` })
    .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)));
  return { wasNewTransition: prevAccount?.tokenStatus !== "invalid" };
}
