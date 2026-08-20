// Repositório do push de WhatsApp (casca, org-scoped). Resolve o alvo (instância
// conectada + contato verificado), garante idempotência por run e persiste a
// conversa/mensagem outbound. Também serve o inbound conversacional (5b-2):
// resolve o contato pelo (instância, telefone), dedupa por messageId e grava
// a conversa/mensagem inbound.

import { and, eq, sql } from "drizzle-orm";
import { channelInstances, contacts, conversations, messages, type Database } from "@trafego/db";

export interface NotifyTarget {
  readonly instanceId: string;
  readonly contactId: string;
  readonly phone: string;
}

/** Contato verificado resolvido a partir do inbound (instância + telefone). */
export interface InboundContact {
  readonly orgId: string;
  readonly contactId: string;
}

/** Alvo de envio a um contato (instância conectada da org + telefone do contato). */
export interface ContactTarget {
  readonly instanceId: string;
  readonly phone: string;
  readonly orgId: string;
}

export type MessageDirection = "inbound" | "outbound";

export interface NotifyRepo {
  loadTarget(orgId: string): Promise<NotifyTarget | null>;
  alreadyNotified(runId: string): Promise<boolean>;
  /** Contato verificado da org dona da instância, pelo telefone (inbound). */
  resolveInboundContact(instanceId: string, phone: string): Promise<InboundContact | null>;
  /** Já processamos esta mensagem do provider? (idempotência do inbound.) */
  alreadyProcessed(messageId: string): Promise<boolean>;
  /** Garante a conversa (org/contato) e devolve seu id. */
  ensureConversation(orgId: string, contactId: string): Promise<string>;
  /** Grava uma mensagem na conversa (in/out) com meta opcional. */
  recordMessage(conversationId: string, direction: MessageDirection, body: string, meta?: Record<string, unknown>): Promise<void>;
  /** Alvo de envio a um contato: instância conectada da org + telefone. */
  resolveOutboundTarget(contactId: string): Promise<ContactTarget | null>;
  /** Atualiza o status do canal pela instância (CONNECTION_UPDATE — status ao vivo). */
  updateInstanceStatus(instanceId: string, status: "connected" | "connecting" | "disconnected"): Promise<void>;
}

export function createNotifyRepo(db: Database): NotifyRepo {
  return {
    /** Instância conectada + 1 contato verificado (dono, no MVP) da org. */
    async loadTarget(orgId) {
      const [instance] = await db
        .select({ instanceId: channelInstances.evolutionInstance })
        .from(channelInstances)
        .where(and(eq(channelInstances.orgId, orgId), eq(channelInstances.status, "connected")))
        .limit(1);
      if (!instance) return null;

      const [contact] = await db
        .select({ id: contacts.id, phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.verified, true)))
        .limit(1);
      if (!contact) return null;

      return { instanceId: instance.instanceId, contactId: contact.id, phone: contact.phone };
    },

    /** Já enviamos a mensagem deste run? (idempotência de envio — 1 msg por run.) */
    async alreadyNotified(runId) {
      const [row] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(sql`${messages.meta} ->> 'runId' = ${runId}`)
        .limit(1);
      return Boolean(row);
    },

    /** Org dona da instância + contato verificado por telefone. Desconhecido → null. */
    async resolveInboundContact(instanceId, phone) {
      const [instance] = await db
        .select({ orgId: channelInstances.orgId })
        .from(channelInstances)
        .where(eq(channelInstances.evolutionInstance, instanceId))
        .limit(1);
      if (!instance) return null;

      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.orgId, instance.orgId), eq(contacts.phone, phone), eq(contacts.verified, true)))
        .limit(1);
      return contact ? { orgId: instance.orgId, contactId: contact.id } : null;
    },

    /** Idempotência do inbound: a mensagem do provider já foi gravada? */
    async alreadyProcessed(messageId) {
      const [row] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(sql`${messages.meta} ->> 'messageId' = ${messageId}`)
        .limit(1);
      return Boolean(row);
    },

    /** Conversa (org/contato) — sem agente atrelado no inbound conversacional. */
    async ensureConversation(orgId, contactId) {
      // orderBy(createdAt) estabiliza o thread_id do checkpointer entre turnos mesmo se
      // uma corrida de 1ª interação criar duplicata (sempre resolve p/ a mais antiga).
      // Hardening (fast-follow): uniqueIndex(org_id, contact_id) + onConflict — precisa
      // dedup das linhas legado por (org, agente, contato) antes.
      const [existing] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.orgId, orgId), eq(conversations.contactId, contactId)))
        .orderBy(conversations.createdAt)
        .limit(1);
      if (existing) return existing.id;
      const [created] = await db
        .insert(conversations)
        .values({ orgId, contactId })
        .returning({ id: conversations.id });
      return created?.id ?? "";
    },

    async recordMessage(conversationId, direction, body, meta) {
      await db.insert(messages).values({ conversationId, direction, body, ...(meta ? { meta } : {}) });
    },

    /** Telefone do contato + instância conectada da sua org. */
    async resolveOutboundTarget(contactId) {
      const [contact] = await db
        .select({ orgId: contacts.orgId, phone: contacts.phone })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      if (!contact) return null;
      const [instance] = await db
        .select({ instanceId: channelInstances.evolutionInstance })
        .from(channelInstances)
        .where(and(eq(channelInstances.orgId, contact.orgId), eq(channelInstances.status, "connected")))
        .limit(1);
      return instance ? { instanceId: instance.instanceId, phone: contact.phone, orgId: contact.orgId } : null;
    },

    async updateInstanceStatus(instanceId, status) {
      await db
        .update(channelInstances)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(channelInstances.evolutionInstance, instanceId));
    },
  };
}
