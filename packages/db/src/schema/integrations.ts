import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { EncryptedPayload } from "@trafego/shared";
import { channelStatus, contactRole, pk, timestamps, tokenStatus } from "./_shared.js";
import { orgs, users } from "./tenancy.js";

/**
 * Conta de anúncios Meta conectada. `token_cripto` = joia da coroa:
 * envelope AES-256-GCM (EncryptedPayload) — nunca em claro, nunca logado.
 */
export const adAccounts = pgTable(
  "ad_accounts",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // Business Manager dono da conta. Nullable: conta pessoal (sem BM) não tem um —
    // guardar null é honesto (vs "" que mascara a ausência). Onboarding deriva da Meta.
    metaBusinessId: text("meta_business_id"),
    adAccountId: text("ad_account_id").notNull(),
    name: text("name"),
    currency: text("currency"),
    tokenCripto: jsonb("token_cripto").$type<EncryptedPayload>().notNull(),
    tokenStatus: tokenStatus("token_status").notNull().default("unchecked"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("ad_accounts_org_idx").on(t.orgId),
    // 1 conta Meta por org (idempotência de "recolar" = upsert atômico, sem duplicar).
    unique("ad_accounts_org_account_uq").on(t.orgId, t.adAccountId),
  ],
);

/** Instância Evolution = 1 número WhatsApp por org. */
export const channelInstances = pgTable(
  "channel_instances",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    evolutionInstance: text("evolution_instance").notNull(),
    phone: text("phone"),
    status: channelStatus("status").notNull().default("disconnected"),
    // secret validado no webhook inbound
    webhookSecret: text("webhook_secret").notNull(),
    ...timestamps,
  },
  (t) => [index("channel_instances_org_idx").on(t.orgId)],
);

/** Telefone WhatsApp vinculado a um user/org (opt-in verificado). */
export const contacts = pgTable(
  "contacts",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    phone: text("phone").notNull(),
    verified: boolean("verified").notNull().default(false),
    role: contactRole("role").notNull().default("member"),
    ...timestamps,
  },
  (t) => [index("contacts_org_idx").on(t.orgId)],
);
