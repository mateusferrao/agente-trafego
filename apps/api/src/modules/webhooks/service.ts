import type { Database } from "@trafego/db";
import type { MessagingChannelPort, SchedulerPort } from "@trafego/shared/ports";

export interface WebhooksDeps {
  readonly db: Database;
  readonly messaging: MessagingChannelPort;
  readonly scheduler: SchedulerPort;
}

export interface InboundResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

/**
 * Slice de webhooks. Recebe inbound da Evolution: valida secret na casca (rota),
 * normaliza via MessagingChannelPort.parseInbound e enfileira o processamento
 * no worker (SchedulerPort) — casca fina, zero lógica de agente aqui (§7/§9).
 */
export function createWebhooksService(deps: WebhooksDeps) {
  return {
    async handleEvolutionInbound(instanceId: string, payload: unknown): Promise<InboundResult> {
      const inbound = deps.messaging.parseInbound(payload);
      // Inbound de desconhecido / não-mensagem = ignora em silêncio (ban-safety §8).
      if (!inbound) {
        return { accepted: false, reason: "ignored" };
      }

      // TODO: resolver org/contato pelo instanceId + from; se contato não verificado, ignora.
      void deps.db;

      await deps.scheduler.enqueue({
        queue: "whatsapp-inbound",
        name: "process-inbound",
        payload: { instanceId, inbound },
        idempotencyKey: `${instanceId}:${inbound.from}:${Date.now()}`,
      });

      return { accepted: true };
    },
  };
}
