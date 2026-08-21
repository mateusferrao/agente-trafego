// Worker da fila de email (6b). Consome `mail.send`: entrega via MailerPort (SES em
// prod, console em dev). Falha propaga → BullMQ retria (attempts/backoff do job).

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { MAIL_QUEUE, MAIL_JOB, type EmailMessage } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";

/** Sobe o Worker BullMQ que entrega os emails enfileirados (`core.mail`). */
export function startMailWorker(deps: WorkerDeps, connection: Redis): Worker<EmailMessage> {
  return new Worker<EmailMessage>(
    MAIL_QUEUE,
    async (job) => {
      if (job.name !== MAIL_JOB) return;
      try {
        await deps.ports.mailer.send(job.data);
        deps.logger.info({ to: job.data.to, category: job.data.category }, "mail:entregue");
      } catch (err) {
        deps.logger.error({ jobId: job.id, to: job.data.to, err }, "mail:falha na entrega");
        throw err; // BullMQ marca failed → retry (attempts/backoff)
      }
    },
    { connection },
  );
}
