import type { ChannelInstanceRef, OutboundMessage } from "@trafego/shared/ports";
import type { EvolutionClient } from "./client.js";

/** Path do endpoint de envio de texto da Evolution v2. */
const SEND_TEXT_PATH = "message/sendText";
/** Presença "digitando…" da Evolution (mostrada durante o `delay` antes de entregar). */
const PRESENCE_COMPOSING = "composing";

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

  /**
   * POST message/sendText/{instanceId}. Body v2 flat `{ number, text }`; quando há
   * `typingHintMs`, adiciona `delay`+`presence:"composing"` (a Evolution mostra
   * "digitando…" por esse tempo antes de entregar) — o único ponto onde o vocabulário
   * de presença do provider aparece (§5). `toIsGroup`: `to` já é o JID do grupo
   * (@g.us) — a Evolution aceita group JID no mesmo campo `number`; NÃO normaliza
   * (normalizePhone destruiria o `@g.us`).
   */
  async sendText(instance: ChannelInstanceRef, msg: OutboundMessage): Promise<void> {
    const typing =
      msg.typingHintMs && msg.typingHintMs > 0 ? { delay: msg.typingHintMs, presence: PRESENCE_COMPOSING } : {};
    const number = msg.toIsGroup ? msg.to : normalizePhone(msg.to);
    // Quoted reply (§5): a Evolution v2 aceita `quoted: { key:{id}, message:{conversation} }`
    // — só o id da msg citada + o texto dela bastam (não precisa remoteJid/participant).
    const quoted = msg.quoted
      ? { quoted: { key: { id: msg.quoted.messageId }, message: { conversation: msg.quoted.text } } }
      : {};
    await this.client.request({
      method: "POST",
      path: `${SEND_TEXT_PATH}/${instance.instanceId}`,
      body: { number, text: msg.text, ...typing, ...quoted },
    });
  }
}
