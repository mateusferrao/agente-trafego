import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { DEFAULT_TIMEZONE } from "@trafego/shared";
import { accessStatus, membershipRole, pk, timestamps } from "./_shared.js";

/** Org = tenant. Raiz de todo scoping por `org_id`. */
export const orgs = pgTable("orgs", {
  id: pk(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Fuso horário da org (Fatia 4) — usado p/ avaliar a cadência (cron) das análises.
  // Default BR (ICP, fonte única em @trafego/shared); editável em Configurações.
  timezone: text("timezone").notNull().default(DEFAULT_TIMEZONE),
  ...timestamps,
});

export const users = pgTable("users", {
  id: pk(),
  email: text("email").notNull().unique(),
  name: text("name"),
  // hash argon2 — nunca a senha em claro
  passwordHash: text("password_hash").notNull(),
  ...timestamps,
});

/** N:N user × org, com papel org-wide (owner|member). RBAC granular = fast-follow. */
export const memberships = pgTable(
  "memberships",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull().default("member"),
    ...timestamps,
  },
  (t) => [index("memberships_org_idx").on(t.orgId), index("memberships_user_idx").on(t.userId)],
);

/**
 * Sessão server-side (§12): o cookie leva um token opaco; o DB guarda só o
 * **hash sha256** (`tokenHash`) — nunca o token em claro. Revogável
 * (`revokedAt`), com expiração deslizante (`lastUsedAt`) e trilha de origem
 * (`ipAddress`/`userAgent`). A org ativa da sessão (`orgId`) mora aqui, não em
 * cookie — troca de org = UPDATE nesta linha (org-switcher, fast-follow).
 */
export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // org ativa da sessão (multi-org)
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    // sha256 do token opaco do cookie (único; nunca guardamos o token cru).
    tokenHash: text("token_hash").notNull().unique(),
    // trilha de origem (auditoria/anti-abuso), opcional.
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // expiração deslizante: atualizado a cada uso autenticado.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Gate de acesso ao produto (keyed por email → allowlist antes do signup). No
 * beta é liberado manualmente; pós-beta o mesmo `status` passa a ser dirigido
 * pelo billing — por isso o nome é neutro (`access_grants`, não `beta_access`).
 */
export const accessGrants = pgTable("access_grants", {
  id: pk(),
  email: text("email").notNull().unique(),
  status: accessStatus("status").notNull().default("pending"),
  note: text("note"),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // quando o acesso passou a `active`.
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  ...timestamps,
});
