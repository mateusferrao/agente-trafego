// Entrypoint do worker (processo separado da api — mesmo repo, entrypoint diferente).
// Boot: composition root → sobe workers BullMQ (agent-runs + insights-sync) →
// shutdown gracioso. Cron por conta + inbound (webhook) entram nas fatias 3b/5b.

import { Redis } from "ioredis";
import { buildComposition, loadConfig } from "./composition.js";
import { startAgentRunsWorker } from "./workers/agent-runs.js";
import { startAgentCronDispatchWorker } from "./workers/agent-cron-dispatch.js";
import { startAgentReaperWorker } from "./workers/agent-reaper.js";
import { startInsightsSyncWorker } from "./workers/insights-sync.js";
import { startInsightsSweepWorker } from "./workers/insights-sweep.js";
import { startScheduleResyncWorker } from "./workers/schedule-resync.js";
import { startActionUndoWorker } from "./workers/action-undo.js";
import { startApprovalApplyWorker } from "./workers/approval-apply.js";
import { startApprovalExpiryWorker } from "./workers/approval-expiry.js";
import { startWebhookInboundWorker } from "./workers/webhook-inbound.js";
import { startWhatsappFlushWorker } from "./workers/whatsapp-flush.js";
import { startWhatsappTranscriptionWorker } from "./workers/whatsapp-transcription.js";
import { startPulseWorker } from "./workers/pulse.js";
import { startMailWorker } from "./workers/mail.js";
import { drainPendingCostPatches } from "./graphs/whatsapp-conversation/nodes.js";
import { makeAccountCron } from "./schedulers/account-cron.js";
import { createRunReaper } from "./modules/dispatch/run-reaper.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await buildComposition();
  const { logger } = deps;

  // conexão Redis dedicada aos workers (BullMQ exige maxRetriesPerRequest=null)
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  // 3a: loop de análise read-only (agent-runs) + sync de insights (2a).
  // 3b: dispatch do cron (cria run por conta no horário) + cadência por conta.
  const cron = makeAccountCron(deps);
  const agentRuns = startAgentRunsWorker(deps, connection);
  const cronDispatch = startAgentCronDispatchWorker(deps, connection);
  const reaper = startAgentReaperWorker(deps, connection);
  const insightsSync = startInsightsSyncWorker(deps, connection);
  // sweep de frescura (6a): mantém insights_snapshots fresco entre análises (sync-only).
  const insightsSweep = startInsightsSweepWorker(deps, connection);
  // resync de schedule por conta (Fatia 4): consome os jobs que a API enfileira ao
  // salvar a cadência — worker é o dono único do scheduler.
  const scheduleResync = startScheduleResyncWorker(deps, connection, cron);

  // undo de ação (5a): consome os jobs que a API enfileira ao pedir "reverter".
  const actionUndo = startActionUndoWorker(deps, connection);

  // aplicação de aprovação (5b): a API enfileira ao aprovar; aqui re-checa fresco + aplica.
  const approvalApply = startApprovalApplyWorker(deps, connection);
  // expiração de aprovações (5b): tick recorrente marca as pendentes vencidas (24h).
  const approvalExpiry = startApprovalExpiryWorker(deps, connection);

  // inbound do WhatsApp (5b-2): a API valida o secret da instância e enfileira o
  // payload cru; aqui normaliza, resolve contato verificado e responde.
  const webhookInbound = startWebhookInboundWorker(deps, connection);
  // flush do debounce (5b-2.4): coalesce mensagens picadas → 1 turno do Grafo B.
  const whatsappFlush = startWhatsappFlushWorker(deps, connection);
  // transcrição de nota de voz inbound: áudio → texto na borda (fila dedicada).
  const whatsappTranscription = startWhatsappTranscriptionWorker(deps, connection);

  // entrega de email transacional (6b): verificação de email + reset de senha.
  const mail = startMailWorker(deps, connection);
  const pulse = startPulseWorker(deps, connection);

  // Sincroniza os schedulers recorrentes a partir dos agentes ativos (idempotente)
  // + agenda o reaper (singleton) e faz uma varredura de boot (limpa presos de um
  // crash anterior antes de esperar o 1º tick).
  await cron.syncAllFromDb().catch((err: unknown) => logger.error({ err }, "cron:sync_all falhou"));
  await cron.ensureReaperSchedule().catch((err: unknown) => logger.error({ err }, "reaper:schedule falhou"));
  await cron
    .ensureApprovalExpirySchedule()
    .catch((err: unknown) => logger.error({ err }, "approval-expiry:schedule falhou"));
  await cron
    .ensureInsightsSweepSchedule()
    .catch((err: unknown) => logger.error({ err }, "insights-sweep:schedule falhou"));
  await createRunReaper({ db: deps.db, logger, staleMinutes: deps.reaper.staleMinutes })
    .reapStale()
    .catch((err: unknown) => logger.error({ err }, "reaper:boot sweep falhou"));
  logger.info("worker up: agent-runs + cron-dispatch + reaper + insights-sync + insights-sweep + schedule-resync + action-undo + approval-apply + approval-expiry + whatsapp-inbound + whatsapp-transcription + mail");

  // shutdown gracioso (drena jobs em andamento antes de sair)
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await Promise.allSettled([
      agentRuns.close(),
      cronDispatch.close(),
      reaper.close(),
      insightsSync.close(),
      insightsSweep.close(),
      scheduleResync.close(),
      actionUndo.close(),
      approvalApply.close(),
      approvalExpiry.close(),
      webhookInbound.close(),
      whatsappFlush.close(),
      whatsappTranscription.close(),
      mail.close(),
      pulse.close(),
    ]);
    // espera (com teto) os patches de custo do WhatsApp em voo — sem isso, todo
    // deploy/restart perde o fallback assíncrono de custo (§11).
    await drainPendingCostPatches();
    await Promise.allSettled([connection.quit(), deps.redis.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // sem logger garantido aqui → console de última instância
  console.error("worker failed to boot", err);
  process.exit(1);
});
