/**
 * Backfill idempotente: normaliza o token de `ad_accounts` para uma
 * `platform_connections` própria (a nova dona do token — ver schema).
 *
 * Mapeamento **1:1** (uma conexão por conta existente): é o retrato honesto do
 * modelo antigo, onde cada conta foi conectada de forma independente com o seu
 * próprio token — nunca mistura tokens de contas distintas. O fluxo novo (slice
 * `connections`) é que passa a criar 1 conexão dona de N contas.
 *
 * Idempotente: só toca contas com `connection_id` nulo — rodar de novo é no-op.
 * Não destrói nada: `ad_accounts.token_cripto` permanece (drop é follow-up).
 */
import { eq, isNull } from "drizzle-orm";
import { adAccounts, platformConnections } from "./schema/index.js";
import { createDb, type Database } from "./client.js";

/** Liga cada conta órfã a uma conexão recém-criada com o mesmo token. */
export async function backfillConnections(db: Database): Promise<{ migrated: number }> {
  const orphans = await db
    .select({
      id: adAccounts.id,
      orgId: adAccounts.orgId,
      metaBusinessId: adAccounts.metaBusinessId,
      name: adAccounts.name,
      tokenCripto: adAccounts.tokenCripto,
      tokenStatus: adAccounts.tokenStatus,
      lastValidatedAt: adAccounts.lastValidatedAt,
    })
    .from(adAccounts)
    .where(isNull(adAccounts.connectionId));

  let migrated = 0;
  for (const account of orphans) {
    await db.transaction(async (tx) => {
      const [connection] = await tx
        .insert(platformConnections)
        .values({
          orgId: account.orgId,
          platform: "meta",
          externalBusinessId: account.metaBusinessId,
          label: account.name,
          tokenCripto: account.tokenCripto,
          tokenStatus: account.tokenStatus,
          lastValidatedAt: account.lastValidatedAt,
        })
        .returning({ id: platformConnections.id });
      if (!connection) throw new Error("backfill: falha ao criar platform_connection");
      await tx
        .update(adAccounts)
        .set({ connectionId: connection.id })
        .where(eq(adAccounts.id, account.id));
    });
    migrated += 1;
  }
  return { migrated };
}

/** Conveniência p/ o boot (abre/fecha o próprio pool, igual ao runMigrations). */
export async function runBackfillConnections(databaseUrl: string): Promise<{ migrated: number }> {
  const db = createDb(databaseUrl);
  return backfillConnections(db);
}
