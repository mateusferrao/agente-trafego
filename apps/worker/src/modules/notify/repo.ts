// Repositório do push de WhatsApp (casca, org-scoped). Resolve o alvo (instância
// conectada + contato verificado), garante idempotência por run e persiste a
// conversa/mensagem outbound.

import { and, eq, sql } from "drizzle-orm";
import { channelInstances, contacts, conversations, messages, type Database } from "@trafego/db";

export interface NotifyTarget {
  readonly instanceId: string;
  readonly contactId: string;
  readonly phone: string;
}

export interface RecordOutboundInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly contactId: string;
  readonly runId: string;
  readonly body: string;
}

export interface NotifyRepo {
  loadTarget(orgId: string): Promise<NotifyTarget | null>;
  alreadyNotified(runId: string): Promise<boolean>;
  recordOutbound(input: RecordOutboundInput): Promise<void>;
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

    /** Garante a conversa (org/agente/contato) e grava a mensagem outbound. */
    async recordOutbound({ orgId, agentId, contactId, runId, body }) {
      const [existing] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.orgId, orgId),
            eq(conversations.agentId, agentId),
            eq(conversations.contactId, contactId),
          ),
        )
        .limit(1);
      let conversationId = existing?.id;
      if (!conversationId) {
        const [created] = await db
          .insert(conversations)
          .values({ orgId, agentId, contactId })
          .returning({ id: conversations.id });
        conversationId = created?.id;
      }
      if (!conversationId) return;

      await db.insert(messages).values({
        conversationId,
        direction: "outbound",
        body,
        meta: { runId },
      });
    },
  };
}
