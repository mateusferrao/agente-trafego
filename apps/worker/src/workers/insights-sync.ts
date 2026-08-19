// Worker do sync de insights (2a). Consome `insights-sync-run`: carrega a conta
// (org-scoped) → decripta o token → roda o sync-service (coleta a série temporal
// → insights_snapshots). Token inválido (190) → marca token_status p/ recolar.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { and, eq, sql } from "drizzle-orm";
import { adAccounts, platformConnections, type Database } from "@trafego/db";
import { INSIGHTS_SYNC_JOB, SYNC_QUEUE, type InsightsSyncPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";

/** Data de referência do sync (UTC). Timezone da conta = refinamento (follow-up). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runInsightsSync(deps: WorkerDeps, payload: InsightsSyncPayload): Promise<void> {
  const { db, ports, logger, insightsSync } = deps;

  // org-scoped: o worker re-escopa (não confia só no enfileirador, §12). Token vem
  // da CONEXÃO dona (fonte da verdade); cai no legado da conta se não houver conexão.
  const [account] = await db
    .select({
      id: adAccounts.id,
      adAccountId: adAccounts.adAccountId,
      status: adAccounts.status,
      accountToken: adAccounts.tokenCripto,
      connToken: platformConnections.tokenCripto,
    })
    .from(adAccounts)
    .leftJoin(platformConnections, eq(adAccounts.connectionId, platformConnections.id))
    .where(and(eq(adAccounts.id, payload.accountId), eq(adAccounts.orgId, payload.orgId)))
    .limit(1);
  if (!account) {
    logger.warn({ accountId: payload.accountId }, "sync:conta não encontrada");
    return;
  }
  // Conta fora de gestão (indisponível/removida) não sincroniza.
  if (account.status !== "active") {
    logger.info({ accountId: account.id, status: account.status }, "sync:conta inativa — pula");
    return;
  }

  const accessToken = ports.vault.decrypt(account.connToken ?? account.accountToken);
  const result = await insightsSync.sync({
    orgId: payload.orgId,
    adAccountUuid: account.id,
    metaAdAccountId: account.adAccountId,
    accessToken,
    today: todayIso(),
  });

  if (result.tokenInvalid) {
    // token não se resolve com retry — marca inválido na CONEXÃO dona (recolar 1x
    // recupera todas as contas dela); conta legada sem conexão cai na própria conta.
    await markTokenInvalid(db, payload.orgId, account.id);
    logger.warn({ accountId: account.id }, "sync:token inválido (190) — marcado p/ recolar");
    return;
  }

  logger.info(
    { accountId: account.id, written: result.snapshotsWritten, partial: result.partial },
    "sync:concluído",
  );
}

/** Marca o token inválido na conexão dona da conta (legado: na própria conta). */
async function markTokenInvalid(db: Database, orgId: string, adAccountUuid: string): Promise<void> {
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

/** Sobe o Worker BullMQ que processa os jobs `insights-sync-run`. */
export function startInsightsSyncWorker(deps: WorkerDeps, connection: Redis): Worker<InsightsSyncPayload> {
  return new Worker<InsightsSyncPayload>(
    SYNC_QUEUE,
    async (job) => {
      if (job.name !== INSIGHTS_SYNC_JOB) return;
      deps.logger.info({ jobId: job.id, accountId: job.data.accountId }, "sync:job recebido");
      try {
        await runInsightsSync(deps, job.data);
      } catch (err) {
        deps.logger.error({ jobId: job.id, err }, "sync:job falhou");
        throw err; // BullMQ marca como failed
      }
    },
    { connection },
  );
}
