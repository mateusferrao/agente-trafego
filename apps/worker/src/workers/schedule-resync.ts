// Worker BullMQ da fila `schedule-resync` (Fatia 4 corte 2): a API enfileira ao
// salvar a cadência; aqui o worker (dono único do scheduler) recarrega o
// `CadenceSpec` + fuso e faz upsert/remove do Job Scheduler recorrente da conta.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { SCHEDULE_RESYNC_QUEUE, type ScheduleResyncPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import type { AccountCron } from "../schedulers/account-cron.js";

export function startScheduleResyncWorker(
  deps: WorkerDeps,
  connection: Redis,
  cron: AccountCron,
): Worker<ScheduleResyncPayload> {
  const { logger } = deps;
  return new Worker<ScheduleResyncPayload>(
    SCHEDULE_RESYNC_QUEUE,
    async (job) => {
      await cron.resyncAccountSchedule(job.data.orgId, job.data.adAccountId);
      logger.info({ adAccountId: job.data.adAccountId }, "schedule:resync");
    },
    { connection },
  );
}
