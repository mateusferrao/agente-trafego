// Worker BullMQ da fila `webhook-inbound`: processa mensagens WhatsApp recebidas
// (a api valida EVOLUTION_WEBHOOK_SECRET e enfileira o payload cru aqui).
// Roteamento do inbound (CLAUDE §8 — ban-safety):
//   1. contato tem aprovação pendente → resolve aprovação (mapeia fala→ações)
//   2. senão → dispara/continua conversa (Grafo B)
//   3. comando "analisa agora" → run on-demand (control-tools)
//   4. remetente DESCONHECIDO (não é contato verificado) → IGNORA em silêncio

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "../composition.js";
import { makeControlToolExecutor } from "../executors/control-tools.js";

export const WEBHOOK_INBOUND_QUEUE = "webhook-inbound";

/** Payload cru do webhook Evolution (normalizado pelo MessagingChannelPort). */
export interface WebhookInboundJob {
  readonly instanceId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export function startWebhookInboundWorker(deps: WorkerDeps, connection: Redis): Worker {
  const { ports, logger } = deps;
  const control = makeControlToolExecutor(deps);

  return new Worker<WebhookInboundJob>(
    WEBHOOK_INBOUND_QUEUE,
    async (job) => {
      // normaliza; parseInbound devolve null quando deve ignorar
      const inbound = ports.messaging.parseInbound(job.data.raw);
      if (!inbound) {
        logger.debug({ jobId: job.id }, "inbound:ignored (unparseable)");
        return;
      }

      // TODO: resolver contato verificado por (instanceId, from). Desconhecido → ignora em silêncio.
      // const contact = await lookupVerifiedContact(inbound.instanceId, inbound.from);
      // if (!contact) { logger.debug("inbound:ignored (unknown sender)"); return; }

      // TODO: 1) approval = await ports.approval.getPendingByContact(contact.id)
      //          → se existe: enfileirar job resume em agent-runs (mapeando fala→ações no Grafo B).
      // TODO: 2) comando explícito "analisa agora" → control.triggerAnalysis(...).
      // TODO: 3) caso geral → invocar Grafo B (whatsapp-conversation) com thread_id = conversationId.
      void control;
      logger.info({ from: inbound.from }, "inbound:route");
    },
    { connection },
  );
}
