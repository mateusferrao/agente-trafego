import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { messageDirection, pk, timestamps } from "./_shared.js";
import { agents } from "./agents.js";
import { orgs } from "./tenancy.js";
import { adAccounts, channelGroups, contacts } from "./integrations.js";

/** Fio de conversa WhatsApp (Grafo B). */
export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    // Fio de GRUPO (aditivo à DM): quando setado, a conversa é dentro de um grupo e a
    // identidade do remetente é o `participant_phone` (não um contato verificado). DM =
    // ambos null + contactId; grupo = ambos setados + contactId null. O thread do
    // checkpointer segue = conversationId, mas a chave lógica é (org, group, participante),
    // o que dá "só o iniciador confirma" + foco por participante de graça.
    groupId: uuid("group_id").references(() => channelGroups.id, { onDelete: "set null" }),
    // telefone E.164 do participante que dirige o bot no grupo (opt-in ativo — LGPD §12:
    // só persistimos de quem fala com o bot, nunca de todo membro do grupo).
    participantPhone: text("participant_phone"),
    // conta em foco (org multi-conta, 5c-6): quando setada, leitura/escrita operam nela.
    // Null = sem foco (org de 1 conta usa a única; multi-conta pede "foca na X").
    focusedAccountId: uuid("focused_account_id").references(() => adAccounts.id, { onDelete: "set null" }),
    // último instante em que o foco foi USADO/setado (staleness): foco velho (> TTL)
    // perde precedência p/ o contexto atual (grupo) ou p/ perguntar (DM). Null = sem foco.
    focusedAt: timestamp("focused_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("conversations_org_idx").on(t.orgId)],
);

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: messageDirection("direction").notNull(),
    body: text("body"),
    // metadados do provider (Evolution): ids, tipos de mídia, etc.
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId)],
);

/**
 * Mensagens de GRUPO NÃO-dirigidas ao bot, guardadas como CONTEXTO (transcript ambiente).
 * Diferente de `messages`: NÃO pertencem a uma thread/conversa (o remetente pode nunca ter
 * falado com o bot) — por isso casa própria, sem fabricar `conversations`. Fonte, junto das
 * `messages` do grupo, do transcript read-only injetado no prompt (só quando o bot é dirigido).
 * Retenção dedicada (purge por idade — §12 LGPD). Dedupe de reentrega por (grupo, messageId).
 */
export const groupMessages = pgTable(
  "group_messages",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => channelGroups.id, { onDelete: "cascade" }),
    // telefone E.164 do autor (quando disponível) — identidade estável p/ atribuição.
    authorPhone: text("author_phone"),
    // nome de exibição do autor no grupo (pushName do WhatsApp) — atribuição legível.
    authorName: text("author_name"),
    // texto da mensagem, ou placeholder de mídia ([áudio]/[imagem]/[mídia]).
    body: text("body"),
    // reply: telefone do autor da mensagem CITADA + trecho dela ("em resposta a X: ...").
    quotedAuthorPhone: text("quoted_author_phone"),
    quotedSnippet: text("quoted_snippet"),
    // id da mensagem no provider — dedupe de reentrega do webhook.
    messageId: text("message_id").notNull(),
    ...timestamps,
  },
  (t) => [
    index("group_messages_group_created_idx").on(t.orgId, t.groupId, t.createdAt),
    unique("group_messages_group_message_uq").on(t.groupId, t.messageId),
  ],
);
