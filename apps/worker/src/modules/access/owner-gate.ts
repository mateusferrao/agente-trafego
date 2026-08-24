// Gate de acesso (beta): a ação proativa age em nome da org → gateia pelo grant do
// OWNER (allowlist por email). Fecha a brecha de org liberada→revogada com conta/cron
// já ativos (§7 do plano). Fonte ÚNICA reusada pelo dispatcher (cron/signal) e pelo
// pulso — sem duplicar a regra por worker.

import { and, eq } from "drizzle-orm";
import { accessGrants, memberships, users, type Database } from "@trafego/db";

/**
 * Algum owner da org está com acesso ATIVO? Filtra status na query (com múltiplos
 * owners, não pega um arbitrário) — roda se QUALQUER owner está liberado.
 */
export async function ownerAccessActive(db: Database, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accessGrants.id })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(accessGrants, eq(accessGrants.email, users.email))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner"), eq(accessGrants.status, "active")))
    .limit(1);
  return row !== undefined;
}
