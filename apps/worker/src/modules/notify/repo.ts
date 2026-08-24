// Repositório do push de WhatsApp (casca, org-scoped). Resolve o alvo (instância
// conectada + contato verificado), garante idempotência por run e persiste a
// conversa/mensagem outbound. Também serve o inbound conversacional (5b-2):
// resolve o contato pelo (instância, telefone), dedupa por messageId e grava
// a conversa/mensagem inbound.

import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { adAccounts, agents, channelGroups, channelInstances, contacts, conversations, groupMessages, messages, type Database } from "@trafego/db";
import { brPhoneVariants, type ConversationRef } from "@trafego/shared";
import type { GroupTranscriptEntry } from "@trafego/core";

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

/** Grupo ativo resolvido a partir do inbound (instância + JID do grupo). */
export interface InboundGroup {
  readonly orgId: string;
  readonly groupId: string;
}

/** Alvo de envio a um grupo (instância conectada + JID do grupo). */
export interface GroupTarget {
  readonly instanceId: string;
  readonly groupJid: string;
  readonly orgId: string;
}

export type MessageDirection = "inbound" | "outbound";

export interface NotifyRepo {
  /**
   * Alvo org-level da proatividade (pulso/alerta/push do cron): grupo ATIVO da org
   * (broadcast, sem participante) se houver; senão o contato DM verificado. Roteamento
   * org-level — configurar o grupo MIGRA a proatividade do DM pro grupo (G2).
   */
  loadTarget(orgId: string): Promise<ConversationRef | null>;
  alreadyNotified(runId: string): Promise<boolean>;
  /** Contato verificado da org dona da instância, pelo telefone (inbound). */
  resolveInboundContact(instanceId: string, phone: string): Promise<InboundContact | null>;
  /** Já processamos esta mensagem do provider? (idempotência do inbound.) */
  alreadyProcessed(messageId: string): Promise<boolean>;
  /** Garante a conversa (org/contato) e devolve seu id. */
  ensureConversation(orgId: string, contactId: string): Promise<string>;
  /** Grava uma mensagem na conversa (in/out) com meta opcional; devolve o id da linha. */
  recordMessage(
    conversationId: string,
    direction: MessageDirection,
    body: string | null,
    meta?: Record<string, unknown>,
  ): Promise<string>;
  /** Atualiza corpo + funde meta (merge jsonb) de uma mensagem por id — pós-transcrição. */
  updateMessageContent(messageRowId: string, body: string | null, metaPatch: Record<string, unknown>): Promise<void>;
  /**
   * Conta em CONTEXTO do fio p/ atribuir custo (metering §6), org-scoped: a única
   * conta ativa da org (sole) OU a conta em FOCO explícito do fio (multi-conta) —
   * mesma resolução de `turn.ts` (sole ?? focused), sem os campos extras (agentId/
   * accountName) que o turno usa e a atribuição de custo não precisa.
   */
  contextAdAccountId(orgId: string, conversationId: string): Promise<string | null>;
  /** Alvo de envio a um contato: instância conectada da org + telefone. */
  resolveOutboundTarget(contactId: string): Promise<ContactTarget | null>;
  /** Atualiza o status do canal pela instância (CONNECTION_UPDATE — status ao vivo). */
  updateInstanceStatus(instanceId: string, status: "connected" | "connecting" | "disconnected"): Promise<void>;
  /** Telefone (E.164) dono da instância — p/ o gate de endereçamento no grupo (menção/reply ao bot). */
  instancePhone(instanceId: string): Promise<string | null>;
  /** Grupo ATIVO da org dona da instância, pelo JID (inbound). Não-registrado/inativo → null. */
  resolveInboundGroup(instanceId: string, groupJid: string): Promise<InboundGroup | null>;
  /**
   * Garante a conversa (org/grupo/participante) e devolve seu id — thread por-(grupo,
   * participante). `participantPhone: null` = thread de BROADCAST do agente (proativo,
   * sem participante específico — pulso/alerta/push).
   */
  ensureGroupConversation(orgId: string, groupId: string, participantPhone: string | null): Promise<string>;
  /**
   * Grava uma mensagem AMBIENTE de grupo (não-dirigida ao bot) como CONTEXTO — sem thread/
   * conversa (o autor pode nunca ter falado com o bot). Idempotente por (grupo, messageId):
   * a reentrega do webhook não duplica.
   */
  recordGroupMessage(input: {
    orgId: string;
    groupId: string;
    authorPhone: string | null;
    authorName: string | null;
    body: string | null;
    messageId: string;
  }): Promise<void>;
  /**
   * Fontes do transcript ambiente do grupo (mescladas pela função pura na casca):
   * ambiente (group_messages) + dirigidas INBOUND (messages via conversations.groupId,
   * com autor do participante + pushName do meta). Corpo nulo (áudio em transcrição /
   * mídia dirigida) é excluído. Outbound do bot no transcript = fast-follow. Janela por
   * `since` (tempo) + `limit` (teto de segurança; a função pura aplica os caps finais).
   * `excludeParticipantPhone`: exclui as DIRIGIDAS desse participante (já vêm no `state.messages`
   * do turno dele — inclusive a mensagem atual, que senão apareceria rotulada como "contexto passado").
   */
  loadGroupTranscriptSources(
    orgId: string,
    groupId: string,
    since: Date,
    limit: number,
    excludeParticipantPhone?: string | null,
  ): Promise<GroupTranscriptEntry[]>;
  /** Apaga mensagens ambiente de grupo criadas antes de `cutoff` (retenção/LGPD). Devolve o nº apagado. */
  purgeGroupMessagesBefore(cutoff: Date): Promise<number>;
  /** Alvo de envio a um grupo: instância conectada da org + JID do grupo. */
  resolveGroupTarget(groupId: string): Promise<GroupTarget | null>;
}

export function createNotifyRepo(db: Database): NotifyRepo {
  return {
    /** Grupo ATIVO da org (broadcast) se houver; senão instância conectada + 1 contato
     *  verificado (DM, dono no MVP). Roteamento org-level (G2). */
    async loadTarget(orgId) {
      const [group] = await db
        .select({ id: channelGroups.id })
        .from(channelGroups)
        .where(and(eq(channelGroups.orgId, orgId), eq(channelGroups.status, "active")))
        .limit(1);
      if (group) return { kind: "group", groupId: group.id, participantPhone: null };

      const [instance] = await db
        .select({ instanceId: channelInstances.evolutionInstance })
        .from(channelInstances)
        .where(and(eq(channelInstances.orgId, orgId), eq(channelInstances.status, "connected")))
        .limit(1);
      if (!instance) return null;

      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.verified, true)))
        .limit(1);
      if (!contact) return null;

      return { kind: "contact", contactId: contact.id };
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

      // WhatsApp nem sempre entrega o mesmo formato p/ celular BR (quirk do
      // `addressingMode: "lid"` — às vezes omite o 9º dígito) — tenta as variantes
      // plausíveis antes de declarar "desconhecido" (ban-safety, CLAUDE.md §8).
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, instance.orgId),
            inArray(contacts.phone, [...brPhoneVariants(phone)]),
            eq(contacts.verified, true),
          ),
        )
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
      const [row] = await db
        .insert(messages)
        .values({ conversationId, direction, body, ...(meta ? { meta } : {}) })
        .returning({ id: messages.id });
      return row?.id ?? "";
    },

    /** Update por PK: corpo + merge do meta (`||` de jsonb) — pós-transcrição (S4). */
    async updateMessageContent(messageRowId, body, metaPatch) {
      await db
        .update(messages)
        .set({
          body,
          meta: sql`coalesce(${messages.meta}, '{}'::jsonb) || ${JSON.stringify(metaPatch)}::jsonb`,
        })
        .where(eq(messages.id, messageRowId));
    },

    /** Conta em contexto do fio (ad_accounts.id) p/ atribuir o custo da transcrição
     *  (§6): sole ativa da org, senão o foco explícito da conversa. Org-scoped em
     *  ambos os passos (evita mis-atribuição cross-org). */
    async contextAdAccountId(orgId, conversationId) {
      const sole = await db
        .select({ adAccountId: agents.adAccountId })
        .from(agents)
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(and(eq(agents.orgId, orgId), eq(agents.status, "active"), eq(adAccounts.status, "active")))
        .limit(2);
      if (sole.length === 1) return sole[0]!.adAccountId;

      const [conv] = await db
        .select({ focusedAccountId: conversations.focusedAccountId })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)))
        .limit(1);
      return conv?.focusedAccountId ?? null;
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

    async instancePhone(instanceId) {
      const [row] = await db
        .select({ phone: channelInstances.phone })
        .from(channelInstances)
        .where(eq(channelInstances.evolutionInstance, instanceId))
        .limit(1);
      return row?.phone ?? null;
    },

    /** Grupo ATIVO da org dona da instância, pelo JID. Sem verificação de membro — a
     *  adesão ao grupo é a fronteira de confiança (CLAUDE §9, diferente do DM). */
    async resolveInboundGroup(instanceId, groupJid) {
      const [instance] = await db
        .select({ orgId: channelInstances.orgId })
        .from(channelInstances)
        .where(eq(channelInstances.evolutionInstance, instanceId))
        .limit(1);
      if (!instance) return null;

      const [group] = await db
        .select({ id: channelGroups.id })
        .from(channelGroups)
        .where(
          and(
            eq(channelGroups.orgId, instance.orgId),
            eq(channelGroups.groupJid, groupJid),
            eq(channelGroups.status, "active"),
          ),
        )
        .limit(1);
      return group ? { orgId: instance.orgId, groupId: group.id } : null;
    },

    /** Conversa (org/grupo/participante) — thread por-participante dá "só o iniciador
     *  confirma" e foco por participante de graça (reuso do foco da DM). `null` = thread
     *  de BROADCAST do agente (proativo, sem participante — `isNull`, `eq` não casa NULL). */
    async ensureGroupConversation(orgId, groupId, participantPhone) {
      const participantCond =
        participantPhone === null
          ? isNull(conversations.participantPhone)
          : eq(conversations.participantPhone, participantPhone);
      const [existing] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.orgId, orgId), eq(conversations.groupId, groupId), participantCond))
        .orderBy(conversations.createdAt)
        .limit(1);
      if (existing) return existing.id;
      const [created] = await db
        .insert(conversations)
        .values({ orgId, groupId, participantPhone })
        .returning({ id: conversations.id });
      return created?.id ?? "";
    },

    /** Mensagem ambiente de grupo (contexto). Upsert idempotente por (grupo, messageId). */
    async recordGroupMessage({ orgId, groupId, authorPhone, authorName, body, messageId }) {
      await db
        .insert(groupMessages)
        .values({ orgId, groupId, authorPhone, authorName, body, messageId })
        .onConflictDoNothing({ target: [groupMessages.groupId, groupMessages.messageId] });
    },

    /** Ambiente (group_messages) + dirigidas inbound (messages do grupo) na janela `since`. */
    async loadGroupTranscriptSources(orgId, groupId, since, limit, excludeParticipantPhone) {
      const ambient = await db
        .select({
          authorPhone: groupMessages.authorPhone,
          authorName: groupMessages.authorName,
          body: groupMessages.body,
          at: groupMessages.createdAt,
        })
        .from(groupMessages)
        .where(and(eq(groupMessages.orgId, orgId), eq(groupMessages.groupId, groupId), gte(groupMessages.createdAt, since)))
        .orderBy(desc(groupMessages.createdAt))
        .limit(limit);

      const directed = await db
        .select({
          authorPhone: conversations.participantPhone,
          authorName: sql<string | null>`${messages.meta} ->> 'authorName'`,
          body: messages.body,
          at: messages.createdAt,
        })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.orgId, orgId),
            eq(conversations.groupId, groupId),
            eq(messages.direction, "inbound"),
            isNotNull(messages.body),
            gte(messages.createdAt, since),
            // as dirigidas do participante corrente já vêm no state.messages do turno dele
            // (inclusive a msg atual) — excluir evita dupla contagem/"contexto passado" falso.
            ...(excludeParticipantPhone ? [ne(conversations.participantPhone, excludeParticipantPhone)] : []),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(limit);

      return [...ambient, ...directed].map((r) => ({ ...r, fromBot: false }));
    },

    /** Purge de retenção do contexto ambiente de grupo (global — a janela vale p/ toda org). */
    async purgeGroupMessagesBefore(cutoff) {
      const deleted = await db
        .delete(groupMessages)
        .where(lt(groupMessages.createdAt, cutoff))
        .returning({ id: groupMessages.id });
      return deleted.length;
    },

    /** JID do grupo + instância conectada da sua org. */
    async resolveGroupTarget(groupId) {
      const [group] = await db
        .select({ orgId: channelGroups.orgId, groupJid: channelGroups.groupJid, evolutionInstance: channelGroups.evolutionInstance })
        .from(channelGroups)
        .where(eq(channelGroups.id, groupId))
        .limit(1);
      if (!group) return null;
      const [instance] = await db
        .select({ instanceId: channelInstances.evolutionInstance })
        .from(channelInstances)
        .where(and(eq(channelInstances.orgId, group.orgId), eq(channelInstances.status, "connected")))
        .limit(1);
      return instance ? { instanceId: instance.instanceId, groupJid: group.groupJid, orgId: group.orgId } : null;
    },
  };
}
