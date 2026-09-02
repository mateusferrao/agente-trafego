// Worker do sync de insights (2a). Consome `insights-sync-run`: carrega a conta
// (org-scoped) → decripta o token → roda o sync-service (coleta a série temporal
// → insights_snapshots). Token inválido (190) → marca token_status p/ recolar.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { and, eq } from "drizzle-orm";
import { adAccounts, agents, loadOrgTimezone, platformConnections } from "@trafego/db";
import {
  addDays,
  detectAccountHealthTriggers,
  describeAccountHealthAlert,
  evaluateDormancy,
  reactivationSignal,
  todayInTz,
  type AccountHealthTriggerEvent,
  type PreviousAccountHealthSnapshot,
} from "@trafego/core";
import {
  DEFAULT_NOTIFY_POLICY,
  INSIGHTS_SYNC_JOB,
  SYNC_QUEUE,
  type InsightsSyncPayload,
  type MetaAccountHealthStatus,
  type NotifyPolicy,
} from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";
import { markConnectionTokenInvalid } from "../lib/mark-token-invalid.js";
import { createRunDispatcher } from "../modules/dispatch/run-dispatcher.js";
import { runAlertGate } from "../modules/alerts/gate.js";
import { makeAccountCron } from "../schedulers/account-cron.js";
import { createDrizzleInsightsSnapshotsRepo } from "../modules/insights/repo.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation } from "../modules/notify/send-to-contact.js";

/** Envia o alerta imediato de saúde de conta (determinístico, sem LLM) pelo mesmo
 *  roteamento de destino do pulso/análise — best-effort, nunca lança. */
async function sendAccountHealthAlert(
  deps: WorkerDeps,
  orgId: string,
  agentId: string,
  event: AccountHealthTriggerEvent,
  accountName: string,
  currency: string,
): Promise<void> {
  try {
    const repo = createNotifyRepo(deps.db);
    const ref = await repo.loadTarget(orgId);
    if (!ref) return;
    const sendToConversation = createSendToConversation({ messaging: deps.ports.messaging, repo });
    const text = describeAccountHealthAlert(event, accountName, currency);
    await sendToConversation(ref, text, { split: false, meta: { accountHealthAlert: event.kind } });
    deps.logger.info({ orgId, agentId, kind: event.kind }, "account-health:alerta enviado");
  } catch (err) {
    deps.logger.warn({ orgId, agentId, kind: event.kind, err }, "account-health:falha ao enviar alerta (ignorado)");
  }
}

export async function runInsightsSync(deps: WorkerDeps, payload: InsightsSyncPayload): Promise<void> {
  const { db, ports, logger, insightsSync } = deps;

  // org-scoped: o worker re-escopa (não confia só no enfileirador, §12). Token vem
  // da CONEXÃO dona (fonte da verdade); cai no legado da conta se não houver conexão.
  const [account] = await db
    .select({
      id: adAccounts.id,
      adAccountId: adAccounts.adAccountId,
      name: adAccounts.name,
      currency: adAccounts.currency,
      status: adAccounts.status,
      tokenStatus: adAccounts.tokenStatus,
      lastActivityAt: adAccounts.lastActivityAt,
      activityState: adAccounts.activityState,
      connectedAt: adAccounts.createdAt,
      accountToken: adAccounts.tokenCripto,
      connToken: platformConnections.tokenCripto,
      // saúde de conta persistida no sync ANTERIOR — base de comparação (Fatia 3).
      metaAccountStatus: adAccounts.metaAccountStatus,
      metaAmountSpent: adAccounts.metaAmountSpent,
      metaBalance: adAccounts.metaBalance,
    })
    .from(adAccounts)
    // join também reafirma a org na conexão (defense-in-depth na joia da coroa).
    .leftJoin(
      platformConnections,
      and(
        eq(adAccounts.connectionId, platformConnections.id),
        eq(platformConnections.orgId, adAccounts.orgId),
      ),
    )
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
  // "hoje" no fuso da org (não UTC) — casa o dia civil dos snapshots (fuso da conta Meta).
  const tz = await loadOrgTimezone(db, payload.orgId, deps.cron.tz);
  const result = await insightsSync.sync({
    orgId: payload.orgId,
    adAccountUuid: account.id,
    metaAdAccountId: account.adAccountId,
    accessToken,
    today: todayInTz(new Date(), tz),
  });

  if (result.tokenInvalid) {
    // token não se resolve com retry — marca inválido na CONEXÃO dona (recolar 1x
    // recupera todas as contas dela); conta legada sem conexão cai na própria conta.
    const { wasNewTransition } = await markConnectionTokenInvalid(db, payload.orgId, account.id);
    logger.warn({ accountId: account.id }, "sync:token inválido (190) — marcado p/ recolar");
    // achado (Fatia 3, saúde de conta): sem acesso, nada mais funciona — alerta SEM
    // toggle, sempre ligado, só na transição (nunca redispara em todo sync de 2h).
    if (wasNewTransition) {
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.adAccountId, account.id), eq(agents.orgId, payload.orgId), eq(agents.status, "active")))
        .limit(1);
      if (agent) {
        await sendAccountHealthAlert(
          deps,
          payload.orgId,
          agent.id,
          { kind: "token_invalid" },
          account.name ?? "sua conta",
          account.currency ?? "BRL",
        );
      }
    }
    return;
  }

  logger.info(
    { accountId: account.id, written: result.snapshotsWritten, partial: result.partial },
    "sync:concluído",
  );

  // Dormância + reativação (pivô) + gate do alerta proativo (F4). Best-effort:
  // falha aqui não invalida o sync.
  try {
    const [agent] = await db
      .select({ id: agents.id, notifyPolicy: agents.notifyPolicy })
      .from(agents)
      .where(and(eq(agents.adAccountId, account.id), eq(agents.orgId, payload.orgId), eq(agents.status, "active")))
      .limit(1);
    if (!agent) return;

    // Saúde da conta Meta (status/teto de gasto/saldo) — Fatia 2 (persistência) + 3
    // (alerta imediato). Best-effort dentro do try já existente: falha aqui não
    // invalida dormância/alerta normal (mesmo espírito de listCustomAudiences/breakdown).
    try {
      const ref: AdAccountRef = { adAccountId: account.adAccountId, accessToken };
      const health = await ports.ads.getAccountHealth(ref);
      const previousHealth: PreviousAccountHealthSnapshot = {
        status: (account.metaAccountStatus as MetaAccountHealthStatus | null) ?? null,
        amountSpentMajor: account.metaAmountSpent !== null ? Number(account.metaAmountSpent) : null,
        balanceMajor: account.metaBalance !== null ? Number(account.metaBalance) : null,
      };
      await db
        .update(adAccounts)
        .set({
          metaAccountStatus: health.status,
          metaDisableReason: health.disableReason ?? null,
          metaBalance: health.balanceMajor !== undefined ? String(health.balanceMajor) : null,
          metaAmountSpent: health.amountSpentMajor !== undefined ? String(health.amountSpentMajor) : null,
          metaSpendCap: health.spendCapMajor !== undefined ? String(health.spendCapMajor) : null,
          metaPaymentMethodLabel: health.paymentMethodLabel ?? null,
          metaFundingType: health.fundingType ?? null,
          metaHealthCheckedAt: new Date(health.checkedAt),
        })
        .where(eq(adAccounts.id, account.id));

      const healthPolicy =
        (agent.notifyPolicy as NotifyPolicy | undefined)?.accountHealthAlert ??
        DEFAULT_NOTIFY_POLICY.accountHealthAlert!;
      const healthEvents = detectAccountHealthTriggers(previousHealth, health, healthPolicy);
      for (const event of healthEvents) {
        await sendAccountHealthAlert(
          deps,
          payload.orgId,
          agent.id,
          event,
          account.name ?? "sua conta",
          account.currency ?? "BRL",
        );
      }
    } catch (err) {
      logger.warn({ accountId: account.id, err }, "account-health:checagem falhou (ignorado)");
    }

    const dispatcher = createRunDispatcher({
      db,
      scheduler: ports.scheduler,
      logger,
      metering: ports.metering,
      envCostCapUsd: deps.costCapUsd,
    });

    // Máquina de dormância: atividade recente (spend/impressões) → transição.
    const today = todayInTz(new Date(), tz);
    const since = addDays(today, -RECENT_ACTIVITY_LOOKBACK_DAYS);
    const snapshotsRepo = createDrizzleInsightsSnapshotsRepo(db);
    const hasActivity = await snapshotsRepo.accountActivitySince(payload.orgId, account.id, since);
    const transition = evaluateDormancy({
      hasActivity,
      currentState: account.activityState,
      lastActivityAt: account.lastActivityAt ? account.lastActivityAt.getTime() : null,
      connectedAt: account.connectedAt.getTime(),
      now: Date.now(),
      afterDays: deps.dormancy.afterDays,
      tokenValid: account.tokenStatus !== "invalid",
      accountActive: account.status === "active",
    });
    const cron = makeAccountCron(deps);

    if (transition.kind === "refresh_activity") {
      await db.update(adAccounts).set({ lastActivityAt: new Date() }).where(eq(adAccounts.id, account.id));
    } else if (transition.kind === "went_dormant") {
      await db.update(adAccounts).set({ activityState: "dormant" }).where(eq(adAccounts.id, account.id));
      await cron.removeAccountSchedule(account.id); // remove análise + pulso
      logger.info({ accountId: account.id }, "dormancy:conta dormante — schedules removidos");
      return; // dormante → não roda o gate de alerta
    } else if (transition.kind === "reactivated") {
      await db
        .update(adAccounts)
        .set({ activityState: "active", lastActivityAt: new Date() })
        .where(eq(adAccounts.id, account.id));
      await cron.resyncAccountSchedule(payload.orgId, account.id); // recria análise + pulso
      logger.info({ accountId: account.id }, "dormancy:conta reativada — schedules recriados");
      const policy = agent.notifyPolicy as NotifyPolicy | undefined;
      if (policy?.reactivation?.enabled) {
        await dispatcher.dispatch({
          orgId: payload.orgId,
          agentId: agent.id,
          adAccountId: account.id,
          trigger: "signal",
          signalFinding: reactivationSignal(account.id, account.name),
        });
      }
      return; // reativação já dispara a 1ª análise — não roda o gate normal
    }

    // Conta ativa e estável → gate do alerta proativo (D-1 vs baseline).
    // Conta DORMANTE (transição `none`) NÃO roda o gate: está em backoff — evita
    // disparar run pago / alerta "gasto zerou" logo após dormir (baseline ainda > 0).
    if (account.activityState === "active") {
      await runAlertGate(
        { db, logger, dispatch: dispatcher.dispatch },
        { orgId: payload.orgId, agentId: agent.id, adAccountId: account.id, fallbackTz: deps.cron.tz },
      );
    }
  } catch (err) {
    logger.warn({ accountId: account.id, err }, "sync:dormância/gate de alerta falhou (ignorado)");
  }
}

/** Janela recente p/ "a conta está rodando agora?" (D-1 + hoje + folga de lag). */
const RECENT_ACTIVITY_LOOKBACK_DAYS = 3;

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
