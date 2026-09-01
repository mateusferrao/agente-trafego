import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { EncryptedPayload } from "@trafego/shared";
import {
  accountLifecycle,
  activityState,
  channelGroupStatus,
  channelStatus,
  contactRole,
  pk,
  platformType,
  timestamps,
  tokenStatus,
} from "./_shared.js";
import { orgs, users } from "./tenancy.js";

/**
 * Conexão com um sistema externo de anúncios (Meta hoje; genérico p/ Google/TikTok).
 * É a dona do `token_cripto` (joia da coroa: envelope AES-256-GCM — nunca em claro,
 * nunca logado). Uma conexão expõe N contas de anúncio (`ad_accounts.connection_id`):
 * recolar o token 1x aqui recupera todas as contas dela.
 */
export const platformConnections = pgTable(
  "platform_connections",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    platform: platformType("platform").notNull().default("meta"),
    // Business Manager (Meta) por trás da conexão. Nullable: conta pessoal sem BM.
    externalBusinessId: text("external_business_id"),
    // Rótulo amigável exibido em Integrações (ex: nome do BM). Opcional.
    label: text("label"),
    tokenCripto: jsonb("token_cripto").$type<EncryptedPayload>().notNull(),
    tokenStatus: tokenStatus("token_status").notNull().default("unchecked"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    // Última descoberta de contas (`sincronizar`) — informativo na UI.
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("platform_connections_org_idx").on(t.orgId)],
);

/**
 * Conta de anúncios sob gestão. Pertence a uma `platform_connections` (que guarda
 * o token). `status` = ciclo de vida (soft — nunca deletar; cascata apagaria agente
 * + histórico, §8/§13). `token_cripto` legado (fonte migra p/ a conexão — drop é
 * follow-up após o backfill).
 */
export const adAccounts = pgTable(
  "ad_accounts",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // Conexão dona do token. Nullable durante o backfill; onDelete restrict —
    // apagar uma conexão nunca deve cascatear delete de conta/agente/histórico.
    connectionId: uuid("connection_id").references(() => platformConnections.id, {
      onDelete: "restrict",
    }),
    // Business Manager dono da conta. Nullable: conta pessoal (sem BM) não tem um —
    // guardar null é honesto (vs "" que mascara a ausência). Onboarding deriva da Meta.
    metaBusinessId: text("meta_business_id"),
    adAccountId: text("ad_account_id").notNull(),
    name: text("name"),
    currency: text("currency"),
    status: accountLifecycle("status").notNull().default("active"),
    // Atividade (pivô): última vez com gasto/impressões + estado (active|dormant).
    // Ortogonal ao `status` (lifecycle de conexão). `last_activity_at` null =
    // nunca teve atividade → o relógio da dormância cai na data de conexão (createdAt).
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    activityState: activityState("activity_state").notNull().default("active"),
    tokenCripto: jsonb("token_cripto").$type<EncryptedPayload>().notNull(),
    tokenStatus: tokenStatus("token_status").notNull().default("unchecked"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    // Saúde da conta NA PRÓPRIA META (status/saldo/gasto/pagamento) — diferente do
    // `status`/lifecycle acima e do `tokenStatus`. Persistido pelo sync periódico
    // (`runInsightsSync`), lido pelo pulso/chat/site sem round-trip à Meta. Nullable:
    // nunca bloqueia conta que ainda não teve essa checagem. Valores monetários já em
    // unidade MAIOR (mesma convenção de `agent_runs.cost_snapshot`).
    metaAccountStatus: text("meta_account_status"),
    metaDisableReason: text("meta_disable_reason"),
    // precisão 16 (não 12): `amount_spent` é acumulado de LONGO PRAZO — conta grande do ICP
    // (agência multi-ano) passa de R$100M e estouraria numeric(12,4); como a persistência é
    // best-effort, o overflow seria engolido em silêncio justo pro cliente de maior valor.
    metaBalance: numeric("meta_balance", { precision: 16, scale: 4 }),
    metaAmountSpent: numeric("meta_amount_spent", { precision: 16, scale: 4 }),
    // ausente = SEM teto definido (a Meta usa "0" pra "sem teto" — o adapter já
    // resolve isso antes de persistir, nunca grava 0 aqui como se fosse um teto real).
    metaSpendCap: numeric("meta_spend_cap", { precision: 16, scale: 4 }),
    metaPaymentMethodLabel: text("meta_payment_method_label"),
    // "stored_balance" (pré-pago genuíno) | "other" (cartão/fatura/etc) — gate do
    // gatilho de saldo baixo na UI (Fatia 3).
    metaFundingType: text("meta_funding_type"),
    metaHealthCheckedAt: timestamp("meta_health_checked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("ad_accounts_org_idx").on(t.orgId),
    index("ad_accounts_connection_idx").on(t.connectionId),
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

/**
 * Grupo WhatsApp configurado pela org — **segunda superfície simétrica à DM**: como
 * `channel_instances` é 1 número por org, `channel_groups` é **1 grupo por org**
 * (`unique(org_id)`; trocar de grupo = UPDATE da linha, não nova linha). O agente atua
 * nele (proativo + conversa) varrendo TODAS as contas da org via concierge (igual à DM);
 * escopo de contas por-grupo é fast-follow (só faz sentido com N números — CLAUDE.md).
 * Membros do grupo NÃO precisam ser contatos verificados (a adesão ao grupo é a fronteira
 * de confiança); verificação segue só no DM 1:1.
 */
export const channelGroups = pgTable(
  "channel_groups",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // instância Evolution (número) que participa do grupo — hoje a única da org.
    evolutionInstance: text("evolution_instance").notNull(),
    // JID do grupo no WhatsApp (…@g.us).
    groupJid: text("group_jid").notNull(),
    // rótulo amigável (assunto do grupo) exibido na UI.
    name: text("name"),
    status: channelGroupStatus("status").notNull().default("active"),
    ...timestamps,
  },
  // 1 grupo por org (espelho do número): reconfigurar = upsert por org, sem duplicar.
  (t) => [unique("channel_groups_org_uq").on(t.orgId)],
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
    // opt-in por código (outbound): guardamos só o HASH do código (nunca em claro) + expiração.
    // Prova de posse do número sem depender de inbound (§9; inbound estrito = 5b).
    verificationCodeHash: text("verification_code_hash"),
    verificationExpiresAt: timestamp("verification_expires_at", { withTimezone: true }),
    // tentativas de confirmação do código atual — passou do teto, o código é
    // invalidado (anti brute-force; complementa o rate-limit da casca).
    verificationAttempts: integer("verification_attempts").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("contacts_org_idx").on(t.orgId),
    // 1 registro por (org, telefone) — reenvio de código = upsert, sem duplicar contato.
    unique("contacts_org_phone_uq").on(t.orgId, t.phone),
  ],
);
