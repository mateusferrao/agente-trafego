// Envio unificado a uma conversa — DM (contato) OU grupo (5b-2 + grupos): resolve
// instância conectada + destino (telefone ou JID de grupo), sanitiza (dialeto
// WhatsApp), quebra opcional (chat), envia com ritmo humano ("digitando…"
// proporcional) e grava a conversa/mensagem outbound. Reusado pelo consumidor de
// inbound (ack/respostas), pelo push do cron/pulso/alerta e pelo apply-service.

import { sanitizeWhatsappText } from "@trafego/core";
import type { ConversationRef } from "@trafego/shared";
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

interface ResolvedDelivery {
  readonly instanceId: string;
  readonly to: string;
  readonly toIsGroup: boolean;
  readonly conversationId: string;
}

/** Resolve o alvo de entrega + a conversa (thread) conforme DM × grupo. */
async function resolveDelivery(repo: NotifyRepo, ref: ConversationRef): Promise<ResolvedDelivery | null> {
  if (ref.kind === "contact") {
    const target = await repo.resolveOutboundTarget(ref.contactId);
    if (!target) return null;
    const conversationId = await repo.ensureConversation(target.orgId, ref.contactId);
    return { instanceId: target.instanceId, to: target.phone, toIsGroup: false, conversationId };
  }
  const target = await repo.resolveGroupTarget(ref.groupId);
  if (!target) return null;
  const conversationId = await repo.ensureGroupConversation(target.orgId, ref.groupId, ref.participantPhone);
  return { instanceId: target.instanceId, to: target.groupJid, toIsGroup: true, conversationId };
}

/** Envia texto a uma conversa (DM ou grupo). Sem alvo resolvível → não envia (false). */
export function createSendToConversation(deps: SendToContactDeps) {
  return async function sendToConversation(
    ref: ConversationRef,
    text: string,
    opts: SendToContactOptions = {},
  ): Promise<boolean> {
    const delivery = await resolveDelivery(deps.repo, ref);
    if (!delivery) return false;

    // Sanitiza SEMPRE (camada única cross-cutting §13): normaliza markdown do LLM p/
    // o dialeto WhatsApp; no-op sobre os textos verbatim já formatados.
    const sanitized = sanitizeWhatsappText(text);
    const parts = opts.split ? splitMessage(sanitized) : [sanitized].filter((p) => p.length > 0);
    if (parts.length === 0) return false;

    // Cada balão leva "digitando…" proporcional (composing+delay no adapter): o ritmo
    // humano vem do canal, não de um sleep fixo. Envio sequencial (await por balão) — a
    // Evolution entrega em ordem de chegada por instância; o `delay` segura cada entrega.
    for (const part of parts) {
      await deps.messaging.sendMessage(
        { instanceId: delivery.instanceId },
        {
          to: delivery.to,
          text: part,
          typingHintMs: computeTypingHint(part),
          ...(delivery.toIsGroup ? { toIsGroup: true } : {}),
        },
      );
      await deps.repo.recordMessage(delivery.conversationId, "outbound", part, opts.meta);
    }
    return true;
  };
}

export type SendToConversation = ReturnType<typeof createSendToConversation>;
