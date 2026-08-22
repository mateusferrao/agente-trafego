// Aviso de cortesia throttled: no MÁXIMO 1 por conversa por janela (SET NX EX) —
// evita parecer spam/bot (ban-safety §9). Reusa o envio unificado (createSendToContact:
// resolve instância+telefone, grava outbound). Contato desconhecido nunca chega aqui
// (o inbound já filtrou §8).

import type { Redis } from "ioredis";
import type { SendToContact } from "../notify/send-to-contact.js";

const NOTICE_THROTTLE_PREFIX = "wa:media-notice:";

export interface CourtesyNoticeArgs {
  readonly conversationId: string;
  readonly contactId: string;
  readonly text: string;
  /** janela do throttle (s) — 1 aviso por conversa por janela. */
  readonly throttleSec: number;
}

/** Envia o aviso se a janela permitir; retorna se realmente enviou. */
export async function sendCourtesyNotice(
  redis: Redis,
  sendToContact: SendToContact,
  args: CourtesyNoticeArgs,
): Promise<boolean> {
  const gate = await redis.set(`${NOTICE_THROTTLE_PREFIX}${args.conversationId}`, "1", "EX", args.throttleSec, "NX");
  if (gate !== "OK") return false; // já avisamos nesta janela
  return sendToContact(args.contactId, args.text, { split: false });
}
