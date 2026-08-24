// Rótulo de auditoria/log/metering do autor de uma ação vinda do WhatsApp — DM (contato
// verificado) ou grupo (participante, sem verificação). Puro: não decide nada, só formata.

import type { ConversationRef } from "@trafego/shared";

export function actorLabel(ref: ConversationRef): string {
  return ref.kind === "contact" ? `contact:${ref.contactId}` : `group:${ref.groupId}:${ref.participantPhone}`;
}
