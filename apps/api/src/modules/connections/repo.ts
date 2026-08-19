import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { adAccounts, platformConnections, type Database } from "@trafego/db";
import type { EncryptedPayload } from "@trafego/shared";
import type { ManagedAccount, SelectPlan, SyncPlan } from "@trafego/core";

export type ConnectionTokenStatus = "valid" | "invalid" | "unchecked";

/** Projeção da conexão p/ a UI (sem o token — nunca sai do backend). */
export interface ConnectionRow {
  readonly id: string;
  readonly platform: "meta";
  readonly label: string | null;
  readonly externalBusinessId: string | null;
  readonly tokenStatus: ConnectionTokenStatus;
  readonly lastValidatedAt: Date | null;
  readonly lastSyncedAt: Date | null;
  readonly accountsCount: number;
}

/** Conexão + token cifrado (uso interno: falar com a plataforma). */
export interface ConnectionWithToken {
  readonly id: string;
  readonly externalBusinessId: string | null;
  readonly tokenCripto: EncryptedPayload;
}

export interface CreateConnectionInput {
  readonly platform: "meta";
  readonly externalBusinessId: string | null;
  readonly label: string | null;
  readonly tokenCripto: EncryptedPayload;
  readonly tokenStatus: ConnectionTokenStatus;
  readonly lastValidatedAt: Date;
}

/**
 * Persistência do slice de conexões (org-scoped — §12). O token é da conexão;
 * `ad_accounts.token_cripto` (legado) é preenchido por dup transitória até o drop.
 */
export interface ConnectionsRepo {
  create(orgId: string, input: CreateConnectionInput): Promise<{ id: string }>;
  /** Conexão existente da org p/ o mesmo negócio (dedupe de recolar token). */
  findByExternalBusinessId(orgId: string, externalBusinessId: string): Promise<ConnectionRow | null>;
  /** Recola o token de uma conexão existente (revalida). */
  updateToken(orgId: string, connectionId: string, tokenCripto: EncryptedPayload): Promise<void>;
  list(orgId: string): Promise<ConnectionRow[]>;
  get(orgId: string, connectionId: string): Promise<ConnectionWithToken | null>;
  /** Contas desta conexão (todos os status — insumo do reconciler). */
  listManaged(orgId: string, connectionId: string): Promise<ManagedAccount[]>;
  /** ids geridos por OUTRA conexão da org (não `removed`) — dedupe cross-conexão. */
  managedElsewhereIds(orgId: string, connectionId: string): Promise<string[]>;
  applySelect(
    orgId: string,
    connectionId: string,
    plan: SelectPlan,
    tokenCripto: EncryptedPayload,
  ): Promise<void>;
  applySync(orgId: string, connectionId: string, plan: SyncPlan): Promise<void>;
  /** Marca o status do token da conexão (ex: inválido quando a busca cai no 190). */
  markTokenStatus(orgId: string, connectionId: string, status: ConnectionTokenStatus): Promise<void>;
}

export function createDrizzleConnectionsRepo(db: Database): ConnectionsRepo {
  return {
    async create(orgId, input) {
      const [row] = await db
        .insert(platformConnections)
        .values({
          orgId,
          platform: input.platform,
          externalBusinessId: input.externalBusinessId,
          label: input.label,
          tokenCripto: input.tokenCripto,
          tokenStatus: input.tokenStatus,
          lastValidatedAt: input.lastValidatedAt,
        })
        .returning({ id: platformConnections.id });
      if (!row) throw new Error("falha ao criar platform_connection");
      return row;
    },

    async list(orgId) {
      const conns = await db
        .select({
          id: platformConnections.id,
          platform: platformConnections.platform,
          label: platformConnections.label,
          externalBusinessId: platformConnections.externalBusinessId,
          tokenStatus: platformConnections.tokenStatus,
          lastValidatedAt: platformConnections.lastValidatedAt,
          lastSyncedAt: platformConnections.lastSyncedAt,
        })
        .from(platformConnections)
        .where(eq(platformConnections.orgId, orgId));

      const counts = await db
        .select({ connectionId: adAccounts.connectionId, n: count() })
        .from(adAccounts)
        .where(and(eq(adAccounts.orgId, orgId), eq(adAccounts.status, "active")))
        .groupBy(adAccounts.connectionId);
      const countByConnection = new Map(counts.map((c) => [c.connectionId, Number(c.n)]));

      return conns.map((c) => ({ ...c, accountsCount: countByConnection.get(c.id) ?? 0 }));
    },

    async findByExternalBusinessId(orgId, externalBusinessId) {
      const [row] = await db
        .select({
          id: platformConnections.id,
          platform: platformConnections.platform,
          label: platformConnections.label,
          externalBusinessId: platformConnections.externalBusinessId,
          tokenStatus: platformConnections.tokenStatus,
          lastValidatedAt: platformConnections.lastValidatedAt,
          lastSyncedAt: platformConnections.lastSyncedAt,
        })
        .from(platformConnections)
        .where(
          and(
            eq(platformConnections.orgId, orgId),
            eq(platformConnections.platform, "meta"),
            eq(platformConnections.externalBusinessId, externalBusinessId),
          ),
        )
        .limit(1);
      if (!row) return null;
      const [c] = await db
        .select({ n: count() })
        .from(adAccounts)
        .where(
          and(
            eq(adAccounts.orgId, orgId),
            eq(adAccounts.connectionId, row.id),
            eq(adAccounts.status, "active"),
          ),
        );
      return { ...row, accountsCount: Number(c?.n ?? 0) };
    },

    async updateToken(orgId, connectionId, tokenCripto) {
      await db
        .update(platformConnections)
        .set({ tokenCripto, tokenStatus: "valid", lastValidatedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(platformConnections.id, connectionId), eq(platformConnections.orgId, orgId)));
    },

    async get(orgId, connectionId) {
      const [row] = await db
        .select({
          id: platformConnections.id,
          externalBusinessId: platformConnections.externalBusinessId,
          tokenCripto: platformConnections.tokenCripto,
        })
        .from(platformConnections)
        .where(and(eq(platformConnections.id, connectionId), eq(platformConnections.orgId, orgId)))
        .limit(1);
      return row ?? null;
    },

    async listManaged(orgId, connectionId) {
      const rows = await db
        .select({ adAccountId: adAccounts.adAccountId, status: adAccounts.status })
        .from(adAccounts)
        .where(and(eq(adAccounts.orgId, orgId), eq(adAccounts.connectionId, connectionId)));
      return rows;
    },

    async managedElsewhereIds(orgId, connectionId) {
      const rows = await db
        .select({ adAccountId: adAccounts.adAccountId })
        .from(adAccounts)
        .where(
          and(
            eq(adAccounts.orgId, orgId),
            ne(adAccounts.status, "removed"),
            // conexão diferente (inclui contas legadas sem conexão, connectionId null).
            sql`(${adAccounts.connectionId} is null or ${adAccounts.connectionId} <> ${connectionId})`,
          ),
        );
      return rows.map((r) => r.adAccountId);
    },

    async applySelect(orgId, connectionId, plan, tokenCripto) {
      await db.transaction(async (tx) => {
        const now = new Date();
        for (const acc of plan.toActivate) {
          await tx
            .insert(adAccounts)
            .values({
              orgId,
              connectionId,
              adAccountId: acc.id,
              name: acc.name,
              currency: acc.currency ?? null,
              status: "active",
              tokenCripto,
              tokenStatus: "valid",
            })
            .onConflictDoUpdate({
              target: [adAccounts.orgId, adAccounts.adAccountId],
              set: {
                connectionId,
                name: acc.name,
                currency: acc.currency ?? null,
                status: "active",
                updatedAt: now,
              },
            });
        }
        if (plan.toRemove.length > 0) {
          await tx
            .update(adAccounts)
            .set({ status: "removed", updatedAt: now })
            .where(
              and(
                eq(adAccounts.orgId, orgId),
                eq(adAccounts.connectionId, connectionId),
                inArray(adAccounts.adAccountId, [...plan.toRemove]),
              ),
            );
        }
      });
    },

    async applySync(orgId, connectionId, plan) {
      await db.transaction(async (tx) => {
        const now = new Date();
        const scope = and(eq(adAccounts.orgId, orgId), eq(adAccounts.connectionId, connectionId));
        // metadados frescos (name/currency) das contas ainda acessíveis.
        for (const acc of plan.toRefresh) {
          await tx
            .update(adAccounts)
            .set({ name: acc.name, currency: acc.currency ?? null, updatedAt: now })
            .where(and(scope, eq(adAccounts.adAccountId, acc.id)));
        }
        if (plan.toReactivate.length > 0) {
          await tx
            .update(adAccounts)
            .set({ status: "active", updatedAt: now })
            .where(and(scope, inArray(adAccounts.adAccountId, [...plan.toReactivate])));
        }
        if (plan.toMarkUnavailable.length > 0) {
          await tx
            .update(adAccounts)
            .set({ status: "unavailable", updatedAt: now })
            .where(and(scope, inArray(adAccounts.adAccountId, [...plan.toMarkUnavailable])));
        }
        await tx
          .update(platformConnections)
          .set({ lastSyncedAt: now, updatedAt: now })
          .where(and(eq(platformConnections.id, connectionId), eq(platformConnections.orgId, orgId)));
      });
    },

    async markTokenStatus(orgId, connectionId, status) {
      await db
        .update(platformConnections)
        .set({ tokenStatus: status, updatedAt: new Date() })
        .where(and(eq(platformConnections.id, connectionId), eq(platformConnections.orgId, orgId)));
    },
  };
}
