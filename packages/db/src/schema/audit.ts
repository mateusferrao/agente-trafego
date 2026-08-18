import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared.js";
import { orgs, users } from "./tenancy.js";

/** Trilha de auditoria de todo write (cross-cutting na casca). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // quem agiu: user, agente ou sistema
    actor: text("actor").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    // alvo: "ad_account:123", "agent:abc", ...
    target: text("target"),
    // contexto genérico do write (método, status, ip, ...) p/ writes de API.
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // estado antes/depois (writes ricos, ex: mutação Meta com rollback — 5a).
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [index("audit_log_org_idx").on(t.orgId)],
);
