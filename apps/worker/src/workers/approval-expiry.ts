// Worker BullMQ da fila `approval-expiry` (5b): consome o tick recorrente e marca
// como `expired` as aprovações pendentes vencidas (24h sem resposta) — sem isso a
// mini-surface/caixa de entrada acumularia propostas velhas. Ver ApprovalPort.expireOverdue.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APPROVAL_EXPIRY_QUEUE, type ApprovalExpiryTickPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";

export function startApprovalExpiryWorker(
  deps: WorkerDeps,
  connection: Redis,
): Worker<ApprovalExpiryTickPayload> {
  return new Worker<ApprovalExpiryTickPayload>(
    APPROVAL_EXPIRY_QUEUE,
    async () => {
      const count = await deps.ports.approval.expireOverdue(new Date());
      if (count > 0) deps.logger.info({ count }, "approval-expiry:expiradas");
    },
    { connection },
  );
}
