import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { messageDirection, pk, timestamps } from "./_shared.js";
import { agents } from "./agents.js";
import { orgs } from "./tenancy.js";
import { contacts } from "./integrations.js";

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
