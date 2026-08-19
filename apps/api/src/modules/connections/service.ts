import type { AccessibleAccount, OrgId } from "@trafego/shared/types";
import { AdsPlatformError, type AdsPlatformPort, type CredentialVaultPort } from "@trafego/shared/ports";
import { reconcileSelect, reconcileSync } from "@trafego/core";
import type { ConnectionRow, ConnectionsRepo } from "./repo.js";
import type {
  ConnectionAccount,
  ConnectionAccountsOutput,
  ConnectionOutput,
  CreateConnectionInput,
  CreateConnectionOutput,
  SelectAccountsInput,
  SyncOutput,
} from "./schema.js";
import { notFound } from "../../middleware/error-handler.js";

export interface ConnectionsDeps {
  readonly repo: ConnectionsRepo;
  readonly adsPlatform: AdsPlatformPort;
  readonly vault: CredentialVaultPort;
}

/**
 * Slice de conexões: colar token → cria a conexão dona do token → o dono escolhe
 * quais contas entram (multi-seleção) e pode sincronizar (redescobrir). A
 * reconciliação (aditiva/não-destrutiva) é do core puro; aqui só faz IO. Erros
 * de plataforma sobem como `AdsPlatformError` (mapeados no error-handler).
 */
export function createConnectionsService(deps: ConnectionsDeps) {
  /** Lista as contas acessíveis; marca a conexão inválida se o token cair. */
  async function fetchAvailable(
    orgId: OrgId,
    connectionId: string,
    token: string,
  ): Promise<AccessibleAccount[]> {
    try {
      return await deps.adsPlatform.listAccessibleAccounts(token);
    } catch (err) {
      if (err instanceof AdsPlatformError && err.kind === "invalid_credential") {
        await deps.repo.markTokenStatus(orgId, connectionId, "invalid");
      }
      throw err;
    }
  }

  /** Resolve a conexão da org ou 404 amigável. */
  async function requireConnection(orgId: OrgId, connectionId: string) {
    const conn = await deps.repo.get(orgId, connectionId);
    if (!conn) throw notFound("Conexão não encontrada.");
    return conn;
  }

  return {
    /**
     * Cola token → valida (lista contas) → cria a conexão dona do token cifrado.
     * **Dedupe:** recolar o token do mesmo negócio atualiza a conexão existente em
     * vez de criar outra (evita conexões órfãs expondo as mesmas contas).
     */
    async create(orgId: OrgId, input: CreateConnectionInput): Promise<CreateConnectionOutput> {
      const available = await deps.adsPlatform.listAccessibleAccounts(input.token);
      const externalBusinessId = available.find((a) => a.businessId)?.businessId ?? null;
      const tokenCripto = deps.vault.encrypt(input.token);
      const now = new Date();

      // Já existe conexão p/ este negócio? → recola o token nela (idempotente).
      if (externalBusinessId) {
        const existing = await deps.repo.findByExternalBusinessId(orgId, externalBusinessId);
        if (existing) {
          await deps.repo.updateToken(orgId, existing.id, tokenCripto);
          const connection = toConnectionOutput({
            ...existing,
            tokenStatus: "valid",
            lastValidatedAt: now,
          });
          return { connection, available: available.map(toConnectionAccount) };
        }
      }

      const { id } = await deps.repo.create(orgId, {
        platform: "meta",
        externalBusinessId,
        label: null,
        tokenCripto,
        tokenStatus: "valid",
        lastValidatedAt: now,
      });
      const connection: ConnectionOutput = {
        id,
        platform: "meta",
        label: null,
        externalBusinessId,
        tokenStatus: "valid",
        lastValidatedAt: now.toISOString(),
        lastSyncedAt: null,
        accountsCount: 0,
      };
      return { connection, available: available.map(toConnectionAccount) };
    },

    async list(orgId: OrgId): Promise<ConnectionOutput[]> {
      const rows = await deps.repo.list(orgId);
      return rows.map(toConnectionOutput);
    },

    /** Contas de uma conexão: acessíveis (ao vivo) + as já geridas. */
    async accounts(orgId: OrgId, connectionId: string): Promise<ConnectionAccountsOutput> {
      const conn = await requireConnection(orgId, connectionId);
      const token = deps.vault.decrypt(conn.tokenCripto);
      const available = await fetchAvailable(orgId, connectionId, token);
      const managed = await deps.repo.listManaged(orgId, connectionId);
      return { available: available.map(toConnectionAccount), managed };
    },

    /** Aplica a multi-seleção do dono (ativa/soft-remove) via reconciler puro. */
    async select(
      orgId: OrgId,
      connectionId: string,
      input: SelectAccountsInput,
    ): Promise<ConnectionAccountsOutput> {
      const conn = await requireConnection(orgId, connectionId);
      const token = deps.vault.decrypt(conn.tokenCripto);
      const available = await fetchAvailable(orgId, connectionId, token);
      const existingHere = await deps.repo.listManaged(orgId, connectionId);
      const managedElsewhereIds = await deps.repo.managedElsewhereIds(orgId, connectionId);
      const plan = reconcileSelect({
        available,
        existingHere,
        selectedIds: input.adAccountIds,
        managedElsewhereIds,
      });
      await deps.repo.applySelect(orgId, connectionId, plan, conn.tokenCripto);
      const managed = await deps.repo.listManaged(orgId, connectionId);
      return { available: available.map(toConnectionAccount), managed };
    },

    /** Redescobre contas e reconcilia (aditivo/não-destrutivo). */
    async sync(orgId: OrgId, connectionId: string): Promise<SyncOutput> {
      const conn = await requireConnection(orgId, connectionId);
      const token = deps.vault.decrypt(conn.tokenCripto);
      const available = await fetchAvailable(orgId, connectionId, token);
      const existingHere = await deps.repo.listManaged(orgId, connectionId);
      const managedElsewhereIds = await deps.repo.managedElsewhereIds(orgId, connectionId);
      const plan = reconcileSync({ available, existingHere, managedElsewhereIds });
      await deps.repo.applySync(orgId, connectionId, plan);
      const managed = await deps.repo.listManaged(orgId, connectionId);
      return {
        available: available.map(toConnectionAccount),
        managed,
        changes: {
          reactivated: plan.toReactivate.length,
          markedUnavailable: plan.toMarkUnavailable.length,
          newAvailable: plan.newAvailable.length,
          connectedElsewhere: plan.connectedElsewhere.length,
        },
      };
    },
  };
}

function toConnectionAccount(account: AccessibleAccount): ConnectionAccount {
  return { id: account.id, name: account.name, ...(account.currency ? { currency: account.currency } : {}) };
}

function toConnectionOutput(row: ConnectionRow): ConnectionOutput {
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    externalBusinessId: row.externalBusinessId,
    tokenStatus: row.tokenStatus,
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    accountsCount: row.accountsCount,
  };
}
