// Worker BullMQ da fila `group-context-purge` (retenção/LGPD): consome o tick recorrente
// (diário) e apaga as mensagens AMBIENTE de grupo além da janela de retenção — o contexto
// usa só o recente; guardar dado de terceiros além da finalidade é o que a retenção evita.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { GROUP_CONTEXT_PURGE_QUEUE, type GroupContextPurgeTickPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { createNotifyRepo } from "../modules/notify/repo.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startGroupContextPurgeWorker(deps: WorkerDeps, connection: Redis): Worker<GroupContextPurgeTickPayload> {
  const repo = createNotifyRepo(deps.db);
  return new Worker<GroupContextPurgeTickPayload>(
    GROUP_CONTEXT_PURGE_QUEUE,
    async () => {
      const cutoff = new Date(Date.now() - deps.conversation.groupContextRetentionDays * MS_PER_DAY);
      const count = await repo.purgeGroupMessagesBefore(cutoff);
      if (count > 0) deps.logger.info({ count }, "group-context-purge:apagadas");
    },
    { connection },
  );
}
