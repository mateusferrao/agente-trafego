import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { betaAccessStatus, membershipRole, pk, timestamps } from "./_shared.js";

/** Org = tenant. Raiz de todo scoping por `org_id`. */
export const orgs = pgTable("orgs", {
  id: pk(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
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

/** Sessão custom (iron-session). Guarda referência p/ revogação. */
export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // org ativa da sessão (multi-org)
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Gate de acesso = allowlist manual de beta. */
export const betaAccess = pgTable("beta_access", {
  id: pk(),
  email: text("email").notNull().unique(),
  status: betaAccessStatus("status").notNull().default("requested"),
  note: text("note"),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  ...timestamps,
});
