// Worker BullMQ da fila `whatsapp-flush` (debounce 5b-2.4): dispara após a janela de
// silêncio; drena os fragmentos bufferizados da conversa e roda UM turno do Grafo B.
// jobId = conversationId → 1 flush por conversa (serializa; sem corrida no checkpointer).
// Se há transcrição de áudio em voo (`wa:transcribing`), ESPERA (re-agenda e não drena)
// — o transcript ainda vai entrar no buffer; drenar agora partiria o turno.

import { Queue, Worker } from "bullmq";
import { WHATSAPP_FLUSH_QUEUE, type WhatsappFlushPayload } from "@trafego/shared";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "../composition.js";
import { drainInbound } from "../modules/conversation/buffer.js";
import { isTranscribing, scheduleConversationFlush } from "../modules/conversation/flush-control.js";
import { runConversationTurn } from "../modules/conversation/turn.js";

export function startWhatsappFlushWorker(deps: WorkerDeps, connection: Redis): Worker<WhatsappFlushPayload> {
  const { logger, redis } = deps;
  const flushQueue = new Queue<WhatsappFlushPayload>(WHATSAPP_FLUSH_QUEUE, { connection });
  const debounceMs = deps.conversation.debounceSeconds * 1000;

  return new Worker<WhatsappFlushPayload>(
    WHATSAPP_FLUSH_QUEUE,
    async (job) => {
      const { orgId, contactId, conversationId } = job.data;

      // Transcrição de áudio em voo → espera: re-agenda a si mesmo e sai sem drenar.
      if (await isTranscribing(redis, conversationId)) {
        await scheduleConversationFlush(flushQueue, { orgId, contactId, conversationId }, debounceMs);
        logger.debug({ conversationId }, "flush:aguardando transcrição");
        return;
      }

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
