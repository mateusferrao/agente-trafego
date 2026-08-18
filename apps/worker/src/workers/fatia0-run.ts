// Worker mínimo da Fatia 0 (bypassa o grafo — 3a assume). Consome `analysis-run`
// da fila e faz o fio: carrega conta → decripta token → busca spend (síncrono) →
// monta mensagem templated → envia no WhatsApp. Sem LLM, sem escrita na Meta.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { and, eq } from "drizzle-orm";
import { adAccounts } from "@trafego/db";
import {
  ANALYSIS_QUEUE,
  ANALYSIS_RUN_JOB,
  formatSpendMessage,
  type AnalysisRunPayload,
} from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";

/** Janela do gasto (Fatia 0). */
const SPEND_DATE_PRESET = "last_7d";
const SPEND_WINDOW_LABEL = "nos últimos 7 dias";
/** Fatia 0: moeda real vem do onboarding (/me/adaccounts, fatia 1b). ICP = BR. */
const DEFAULT_CURRENCY = "BRL";

/**
 * Executa o fio da Fatia 0 para uma conta. IO só via portas injetadas (testável
 * com mocks). Idempotência de escrita não se aplica (read-only na Meta); a fila
 * usa `attempts: 1` (default BullMQ) p/ não reenviar em falha parcial.
 */
export async function runAnalysis(deps: WorkerDeps, payload: AnalysisRunPayload): Promise<void> {
  const { db, ports, logger, fatia0 } = deps;

  // org-scoped mesmo no fio da Fatia 0 — o worker não confia só no enfileirador (§12).
  const [account] = await db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.id, payload.accountId), eq(adAccounts.orgId, payload.orgId)))
    .limit(1);
  if (!account) {
    logger.warn({ accountId: payload.accountId }, "fatia0:conta não encontrada");
    return;
  }

  const accessToken = ports.vault.decrypt(account.tokenCripto);
  const rows = await ports.ads.getInsights({
    account: { adAccountId: account.adAccountId, accessToken },
    level: "account",
    window: SPEND_DATE_PRESET,
    fields: ["spend"],
  });
  const spend = rows[0]?.metrics.spend ?? 0;

  const text = formatSpendMessage({
    accountName: account.name ?? account.adAccountId,
    currency: account.currency ?? DEFAULT_CURRENCY,
    spend,
    windowLabel: SPEND_WINDOW_LABEL,
  });

  await ports.messaging.sendMessage(
    { instanceId: fatia0.evolutionInstance },
    { to: fatia0.recipientPhone, text },
  );
  logger.info({ accountId: payload.accountId, spend }, "fatia0:mensagem enviada");
}

/** Sobe o Worker BullMQ que processa os jobs `analysis-run` da Fatia 0. */
export function startFatia0Worker(deps: WorkerDeps, connection: Redis): Worker<AnalysisRunPayload> {
  return new Worker<AnalysisRunPayload>(
    ANALYSIS_QUEUE,
    async (job) => {
      if (job.name !== ANALYSIS_RUN_JOB) return; // ignora outros jobs da fila
      deps.logger.info({ jobId: job.id, accountId: job.data.accountId }, "fatia0:job recebido");
      try {
        await runAnalysis(deps, job.data);
      } catch (err) {
        // falha tratada + observável (nunca engole o erro em silêncio)
        deps.logger.error({ jobId: job.id, err }, "fatia0:job falhou");
        throw err; // deixa o BullMQ marcar como failed
      }
    },
    { connection },
  );
}
