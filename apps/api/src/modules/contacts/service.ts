import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { contacts, type Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { MessagingChannelPort } from "@trafego/shared/ports";
import { badRequest } from "../../middleware/error-handler.js";
import { resolveConnectedInstance } from "../channels/service.js";
import type { StartVerificationInput, ConfirmVerificationInput } from "./schema.js";

export interface ContactsDeps {
  readonly db: Database;
  readonly messaging: MessagingChannelPort;
}

const CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const CODE_MIN = 100000;
const CODE_MAX = 999999; // 6 dígitos
/** Teto de tentativas por código: passou disso, o código é invalidado (anti brute-force). */
const MAX_CONFIRM_ATTEMPTS = 5;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("base64");
}

/** Comparação em tempo constante de dois hashes base64 (evita timing attack). */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Decisão pura: o código digitado bate com o hash guardado e não expirou? */
export function isCodeValid(
  stored: { codeHash: string | null; expiresAt: Date | null },
  code: string,
  now: number,
): boolean {
  if (!stored.codeHash || !stored.expiresAt) return false;
  if (stored.expiresAt.getTime() < now) return false;
  return hashesEqual(stored.codeHash, hashCode(code));
}

/** Hash do código (exportado p/ testes gerarem o gabarito). */
export function hashVerificationCode(code: string): string {
  return hashCode(code);
}

/**
 * Opt-in do contato por código (§9): enviamos um código pelo WhatsApp (outbound) e
 * o dono confirma no site → `verified=true`. Prova posse do número sem depender de
 * inbound (inbound estrito = 5b). Guardamos só o HASH do código, com expiração.
 */
export function createContactsService(deps: ContactsDeps) {
  /** Gera + envia o código pro telefone (exige a instância da org conectada). */
  async function startVerification(
    orgId: OrgId,
    input: StartVerificationInput,
  ): Promise<{ sent: true; expiresAt: string }> {
    const instance = await resolveConnectedInstance(deps.db, orgId);
    if (!instance) {
      throw badRequest("Conecte o WhatsApp da sua conta antes de verificar um número.");
    }

    const code = String(randomInt(CODE_MIN, CODE_MAX + 1));
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await deps.db
      .insert(contacts)
      .values({
        orgId,
        phone: input.phone,
        role: "owner",
        verified: false,
        verificationCodeHash: hashCode(code),
        verificationExpiresAt: expiresAt,
        verificationAttempts: 0,
        ...(input.userId ? { userId: input.userId } : {}),
      })
      .onConflictDoUpdate({
        target: [contacts.orgId, contacts.phone],
        set: {
          verificationCodeHash: hashCode(code),
          verificationExpiresAt: expiresAt,
          verificationAttempts: 0, // novo código → zera o contador de tentativas
          verified: false,
          updatedAt: sql`now()`,
        },
      });

    await deps.messaging.sendMessage(instance, {
      to: input.phone,
      text: `Seu código de verificação do CaquiAI é ${code}. Ele expira em ${CODE_TTL_MS / 60000} minutos.`,
    });
    return { sent: true, expiresAt: expiresAt.toISOString() };
  }

  /** Contato destinatário atual da org (verificado), p/ a tela refletir o estado. */
  async function getRecipient(orgId: OrgId): Promise<{ phone: string; verified: boolean } | null> {
    const [contact] = await deps.db
      .select({ phone: contacts.phone, verified: contacts.verified })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.verified, true)))
      .limit(1);
    return contact ?? null;
  }

  /** Remove o destinatário verificado da org (trocar/desvincular o número). */
  async function removeRecipient(orgId: OrgId): Promise<{ removed: boolean }> {
    const removed = await deps.db
      .delete(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.verified, true)))
      .returning({ id: contacts.id });
    return { removed: removed.length > 0 };
  }

  /** Confirma o código digitado no site → marca o contato como verificado. */
  async function confirmVerification(
    orgId: OrgId,
    input: ConfirmVerificationInput,
  ): Promise<{ verified: true }> {
    const [contact] = await deps.db
      .select({
        id: contacts.id,
        codeHash: contacts.verificationCodeHash,
        expiresAt: contacts.verificationExpiresAt,
        attempts: contacts.verificationAttempts,
      })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.phone, input.phone)))
      .limit(1);

    const invalid = "Código inválido ou expirado. Peça um novo código e tente de novo.";
    if (!contact || !isCodeValid(contact, input.code, Date.now())) {
      // tentativa contra um código vivo → conta; passou do teto, invalida o código
      // (anti brute-force, defesa em profundidade além do rate-limit da casca).
      if (contact?.codeHash) {
        const attempts = (contact.attempts ?? 0) + 1;
        const exhausted = attempts >= MAX_CONFIRM_ATTEMPTS;
        await deps.db
          .update(contacts)
          .set({
            verificationAttempts: attempts,
            ...(exhausted ? { verificationCodeHash: null, verificationExpiresAt: null } : {}),
            updatedAt: sql`now()`,
          })
          .where(and(eq(contacts.id, contact.id), eq(contacts.orgId, orgId)));
      }
      throw badRequest(invalid);
    }

    await deps.db
      .update(contacts)
      .set({
        verified: true,
        verificationCodeHash: null,
        verificationExpiresAt: null,
        verificationAttempts: 0,
        updatedAt: sql`now()`,
      })
      .where(and(eq(contacts.id, contact.id), eq(contacts.orgId, orgId)));
    // 1 destinatário por org (MVP): desverifica os outros → getRecipient/remove/notify
    // ficam determinísticos (todos leem "verified=true" limit 1).
    await deps.db
      .update(contacts)
      .set({ verified: false, updatedAt: sql`now()` })
      .where(and(eq(contacts.orgId, orgId), eq(contacts.verified, true), ne(contacts.id, contact.id)));
    return { verified: true };
  }

  return { startVerification, confirmVerification, getRecipient, removeRecipient };
}
