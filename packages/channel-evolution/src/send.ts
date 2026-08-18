import type { ChannelInstanceRef, OutboundMessage } from "@trafego/shared/ports";
import type { EvolutionClient } from "./client.js";

/** Path do endpoint de envio de texto da Evolution v2. */
const SEND_TEXT_PATH = "message/sendText";

/** Evolution espera só dígitos com DDI (resolve o JID internamente) — sem +/espaços. */
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

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
  async sendText(instance: ChannelInstanceRef, msg: OutboundMessage): Promise<void> {
    await this.client.request({
      method: "POST",
      path: `${SEND_TEXT_PATH}/${instance.instanceId}`,
      body: { number: normalizePhone(msg.to), text: msg.text },
    });
  }
}
