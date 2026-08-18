import type { InboundMessage } from "@trafego/shared/ports";

/**
 * Normalização do payload cru do webhook da Evolution → `InboundMessage`.
 *
 * NÃO valida secret aqui — a casca já validou `EVOLUTION_WEBHOOK_SECRET` antes de
 * chamar isto (§9). Retorna `null` quando o evento não é uma mensagem de texto
 * inbound processável (ex: status/ACK, fromMe=true, tipo não suportado).
 */

/** Nomes de evento relevantes da Evolution (messages.upsert é o principal). */
export type EvolutionEvent = "messages.upsert" | "connection.update" | (string & {});

export interface EvolutionWebhookPayload {
  readonly event?: EvolutionEvent;
  readonly instance?: string;
  readonly data?: unknown;
}

/** Extrai a mensagem inbound normalizada, ou null se deve ser ignorada. */
export function parseInbound(payload: unknown): InboundMessage | null {
  // TODO: narrow do payload; ignorar fromMe/ACK/não-texto; extrair instanceId,
  //       remoteJid → E.164 (from), conversation/extendedTextMessage → text.
  throw new Error("not implemented");
}

/** Converte um JID do WhatsApp (55...@s.whatsapp.net) em telefone E.164. */
export function jidToE164(jid: string): string | null {
  // TODO: strip sufixo @s.whatsapp.net/@g.us; grupos (@g.us) → null.
  throw new Error("not implemented");
}
