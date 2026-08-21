import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps, tokenPurpose } from "./_shared.js";
import { users } from "./tenancy.js";

/**
 * Tokens de uso único (6b): verificação de email (OTP 6 dígitos) + reset de senha
 * (token opaco em link). Só o **hash** persiste (sha256) — nunca o token em claro.
 * Uso único via UPDATE condicional a `consumedAt IS NULL` (sem check-then-write).
 * `userId` nullable (o reset pode nascer antes de resolver o user; email é a chave lógica).
 */
export const oneTimeTokens = pgTable(
  "one_time_tokens",
  {
    id: pk(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    purpose: tokenPurpose("purpose").notNull(),
    // sha256 do token (código-email = hash de `email:code`; reset = hash do token opaco).
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // uso único: setado ao consumir (UPDATE WHERE consumed_at IS NULL).
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (t) => [index("one_time_tokens_email_idx").on(t.email)],
);
