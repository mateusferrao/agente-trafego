// Worker BullMQ da fila `action-undo` (5a): a API valida a posse + enfileira; aqui o
// worker (dono do governor/escrita) delega ao núcleo compartilhado `revertActionById`
// (carrega o tool_call org-scoped, reaplica o before_state, idempotente). Mesmo núcleo
// reusado pela tool `revert` do chat (5c-4).

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { ACTION_UNDO_QUEUE, type ActionUndoPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { revertActionById } from "../modules/apply/revert-action.js";

export function startActionUndoWorker(deps: WorkerDeps, connection: Redis): Worker<ActionUndoPayload> {
  const { logger } = deps;

  return new Worker<ActionUndoPayload>(
    ACTION_UNDO_QUEUE,
    async (job) => {
      const { orgId, toolCallId, force } = job.data;
      const res = await revertActionById(deps, { orgId, toolCallId, force: force ?? false });
      logger.info(
        { toolCallId, reverted: res.reverted, blockedByDrift: res.blockedByDrift, reason: res.reason },
        "undo:processado",
      );
    },
    { connection },
  );
}
