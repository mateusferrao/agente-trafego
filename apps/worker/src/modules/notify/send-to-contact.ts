// Envio unificado a um contato (5b-2): resolve instância conectada + telefone,
// quebra opcional (chat), envia e grava a conversa/mensagem outbound. Reusado pelo
// consumidor de inbound (ack/respostas), pelo push do cron e pelo apply-service (T2).

import { sleep as defaultSleep } from "@trafego/shared";
import type { MessagingChannelPort } from "@trafego/shared/ports";
import type { NotifyRepo } from "./repo.js";
import { WHATSAPP_PART_DELAY_MS, splitMessage } from "./split.js";

export interface SendToContactDeps {
  readonly messaging: MessagingChannelPort;
  readonly repo: NotifyRepo;
  /** injetável p/ teste (evita timer real entre partes). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SendToContactOptions {
  /** Chat quebra em `\n\n`; cron/verificação enviam inteiro (ban-safety §9). */
  readonly split?: boolean;
  readonly meta?: Record<string, unknown>;
}

/** Envia texto a um contato. Sem instância conectada/contato → não envia (retorna false). */
export function createSendToContact(deps: SendToContactDeps) {
  const sleep = deps.sleep ?? defaultSleep;

  return async function sendToContact(
    contactId: string,
    text: string,
    opts: SendToContactOptions = {},
  ): Promise<boolean> {
    const target = await deps.repo.resolveOutboundTarget(contactId);
    if (!target) return false;

    const parts = opts.split
      ? splitMessage(text)
      : [text.trim()].filter((p) => p.length > 0);
    if (parts.length === 0) return false;

    const conversationId = await deps.repo.ensureConversation(target.orgId, contactId);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      await deps.messaging.sendMessage({ instanceId: target.instanceId }, { to: target.phone, text: part });
      await deps.repo.recordMessage(conversationId, "outbound", part, opts.meta);
      if (i < parts.length - 1) await sleep(WHATSAPP_PART_DELAY_MS);
    }
    return true;
  };
}

export type SendToContact = ReturnType<typeof createSendToContact>;
