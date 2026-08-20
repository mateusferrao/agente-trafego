// Worker BullMQ da fila `whatsapp-flush` (debounce 5b-2.4): dispara após a janela de
// silêncio; drena os fragmentos bufferizados da conversa e roda UM turno do Grafo B.
// jobId = conversationId → 1 flush por conversa (serializa; sem corrida no checkpointer).

import { Worker } from "bullmq";
import { WHATSAPP_FLUSH_QUEUE, type WhatsappFlushPayload } from "@trafego/shared";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "../composition.js";
import { drainInbound } from "../modules/conversation/buffer.js";
import { runConversationTurn } from "../modules/conversation/turn.js";

export function startWhatsappFlushWorker(deps: WorkerDeps, connection: Redis): Worker<WhatsappFlushPayload> {
  const { logger, redis } = deps;

  return new Worker<WhatsappFlushPayload>(
    WHATSAPP_FLUSH_QUEUE,
    async (job) => {
      const { orgId, contactId, conversationId } = job.data;
      // Laço: drena + roda o turno até o buffer esvaziar. Mensagens que chegam
      // DURANTE o turno (quando o re-agendamento por jobId é engolido) são pegas
      // na próxima iteração — nenhum fragmento fica represado sem resposta.
      for (;;) {
        const fragments = await drainInbound(redis, conversationId);
        if (fragments.length === 0) {
          logger.debug({ conversationId }, "flush:vazio (drenado)");
          return;
        }
        // coalesce as mensagens picadas num único turno (na ordem de chegada).
        await runConversationTurn(deps, { orgId, contactId, conversationId, text: fragments.join("\n") });
      }
    },
    { connection },
  );
}
