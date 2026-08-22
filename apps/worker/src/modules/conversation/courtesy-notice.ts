// Aviso de cortesia throttled: no MÁXIMO 1 por conversa por janela (SET NX EX) —
// evita parecer spam/bot (ban-safety §9). Reusa o envio unificado (createSendToContact:
// resolve instância+telefone, grava outbound). Contato desconhecido nunca chega aqui
// (o inbound já filtrou §8).

import type { Redis } from "ioredis";
import type { SendToContact } from "../notify/send-to-contact.js";

const NOTICE_THROTTLE_PREFIX = "wa:notice:";

export interface CourtesyNoticeArgs {
  readonly conversationId: string;
  readonly contactId: string;
  readonly text: string;
  /**
   * Balde do throttle (motivo) — avisos de motivos DIFERENTES não se engolem: um aviso
   * de mídia não pode suprimir o "não consegui ouvir" de um áudio na mesma janela.
   */
  readonly bucket: string;
  /** janela do throttle (s) — 1 aviso por conversa/balde por janela. */
  readonly throttleSec: number;
}

/** Envia o aviso se a janela do balde permitir; retorna se realmente enviou. */
export async function sendCourtesyNotice(
  redis: Redis,
  sendToContact: SendToContact,
  args: CourtesyNoticeArgs,
): Promise<boolean> {
  const key = `${NOTICE_THROTTLE_PREFIX}${args.bucket}:${args.conversationId}`;
  const gate = await redis.set(key, "1", "EX", args.throttleSec, "NX");
  if (gate !== "OK") return false; // já avisamos deste motivo nesta janela
  return sendToContact(args.contactId, args.text, { split: false });
}
