// Helper compartilhado (lógica sensível de credencial — uma fonte só). Marca o
// token inválido na CONEXÃO dona da conta (recolar 1x recupera todas as contas
// dela); conta legada sem conexão cai no status da própria conta. Usado pelo
// insights-sync e pelo grafo de análise.
import { and, eq, ne, sql } from "drizzle-orm";
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
  // Transição ATÔMICA (read-then-write num só UPDATE ... WHERE != 'invalid' RETURNING):
  // duas syncs concorrentes de contas da MESMA conexão não podem ambas "ver válido" e
  // ambas disparar o alerta — só a 1ª atualiza uma linha (transição real). `wasNewTransition`
  // = houve linha afetada (achado da revisão; sem isso o read-then-write racearia).
  if (account?.connectionId) {
    const updated = await db
      .update(platformConnections)
      .set({ tokenStatus: "invalid", updatedAt: sql`now()` })
      .where(
        and(
          eq(platformConnections.id, account.connectionId),
          eq(platformConnections.orgId, orgId),
          ne(platformConnections.tokenStatus, "invalid"),
        ),
      )
      .returning({ id: platformConnections.id });
    return { wasNewTransition: updated.length > 0 };
  }
  const updated = await db
    .update(adAccounts)
    .set({ tokenStatus: "invalid", updatedAt: sql`now()` })
    .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId), ne(adAccounts.tokenStatus, "invalid")))
    .returning({ id: adAccounts.id });
  return { wasNewTransition: updated.length > 0 };
}
