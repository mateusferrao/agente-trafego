import type { ChannelInstanceRef, OutboundMessage } from "@trafego/shared/ports";
import type { EvolutionClient } from "./client.js";

/**
 * Envio de mensagens de texto via Evolution (message/sendText/{instance}).
 * Outbound proativo é livre (sem janela 24h) — ban-safety/throttle é na casca (§9).
 */
export class EvolutionSender {
  private readonly client: EvolutionClient;

  constructor(client: EvolutionClient) {
    this.client = client;
  }

  /** POST message/sendText/{instanceId} com { number, text }. */
  sendText(instance: ChannelInstanceRef, msg: OutboundMessage): Promise<void> {
    // TODO: normalizar telefone E.164 → JID; POST sendText; mapear resposta.
    throw new Error("not implemented");
  }
}
