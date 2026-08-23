// Envio unificado a um contato (5b-2): resolve instância conectada + telefone,
// sanitiza (dialeto WhatsApp), quebra opcional (chat), envia com ritmo humano
// ("digitando…" proporcional) e grava a conversa/mensagem outbound. Reusado pelo
// consumidor de inbound (ack/respostas), pelo push do cron e pelo apply-service (T2).

import { sanitizeWhatsappText } from "@trafego/core";
import type { MessagingChannelPort } from "@trafego/shared/ports";
import type { NotifyRepo } from "./repo.js";
import { splitMessage } from "./split.js";
import { computeTypingHint } from "./typing.js";

export interface SendToContactDeps {
  readonly messaging: MessagingChannelPort;
  readonly repo: NotifyRepo;
}

export interface SendToContactOptions {
  /** Chat quebra em balões; cron/verificação enviam inteiro (ban-safety §9). */
  readonly split?: boolean;
  readonly meta?: Record<string, unknown>;
}

/** Envia texto a um contato. Sem instância conectada/contato → não envia (retorna false). */
export function createSendToContact(deps: SendToContactDeps) {
  return async function sendToContact(
    contactId: string,
    text: string,
    opts: SendToContactOptions = {},
  ): Promise<boolean> {
    const target = await deps.repo.resolveOutboundTarget(contactId);
    if (!target) return false;

    // Sanitiza SEMPRE (camada única cross-cutting §13): normaliza markdown do LLM p/
    // o dialeto WhatsApp; no-op sobre os textos verbatim já formatados.
    const sanitized = sanitizeWhatsappText(text);
    const parts = opts.split ? splitMessage(sanitized) : [sanitized].filter((p) => p.length > 0);
    if (parts.length === 0) return false;

    const conversationId = await deps.repo.ensureConversation(target.orgId, contactId);
    // Cada balão leva "digitando…" proporcional (composing+delay no adapter): o ritmo
    // humano vem do canal, não de um sleep fixo. Envio sequencial (await por balão) — a
    // Evolution entrega em ordem de chegada por instância; o `delay` segura cada entrega.
    for (const part of parts) {
      await deps.messaging.sendMessage(
        { instanceId: target.instanceId },
        { to: target.phone, text: part, typingHintMs: computeTypingHint(part) },
      );
      await deps.repo.recordMessage(conversationId, "outbound", part, opts.meta);
    }
    return true;
  };
}

export type SendToContact = ReturnType<typeof createSendToContact>;
