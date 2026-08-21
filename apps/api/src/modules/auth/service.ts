import { isUniqueViolation } from "@trafego/db";
import { checkPasswordStrength, type PasswordWeakReason } from "@trafego/core";
import type { MailQueuePort } from "@trafego/shared/ports";
import { badRequest, emailNotVerified, unauthorized } from "../../middleware/error-handler.js";
import type { PasswordHasher } from "./password.js";
import type { AuthRepo, PrincipalRow } from "./repo.js";
import {
  computeSessionExpiry,
  generateSessionToken,
  hashSessionToken,
  SESSION_SLIDE_THROTTLE_MS,
} from "./session-token.js";
import { generateEmailCode, generateResetToken, hashEmailCode, hashOneTimeToken } from "./one-time-token.js";
import { buildVerificationEmail, buildAccountExistsEmail, buildPasswordResetEmail } from "./auth-email.js";
import type {
  EmailCodeRequestInput,
  EmailCodeVerifyInput,
  ForgotPasswordInput,
  LoginInput,
  MeOutput,
  ResetPasswordInput,
  SignupInput,
  SignupOutput,
} from "./schema.js";

/** Config de email do auth (TTLs + remetente + URL do app p/ links). */
export interface AuthEmailConfig {
  readonly from: string;
  readonly appUrl: string;
  readonly codeTtlMinutes: number;
  readonly resetTtlMinutes: number;
}

export interface AuthDeps {
  readonly repo: AuthRepo;
  readonly hasher: PasswordHasher;
  /** Enfileira email transacional (verificação/reset) — nunca envia inline. */
  readonly mailQueue: MailQueuePort;
  readonly email: AuthEmailConfig;
  /** Relógio injetável (testabilidade). Default = `Date`. */
  readonly now?: () => Date;
}

/** Principal autenticado que a casca grava na sessão/scoping. */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly orgId: string | null;
}

/** Origem da request p/ trilha da sessão (nunca vem de input do usuário). */
export interface SessionContext {
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * Resultado de login/verificação: o token opaco (vai p/ o cookie) + o `MeOutput`.
 * O service não conhece cookies.
 */
export interface SessionIssued {
  readonly rawToken: string;
  readonly me: MeOutput;
}

function toMe(p: PrincipalRow): MeOutput {
  return {
    userId: p.userId,
    email: p.email,
    name: p.name,
    orgId: p.orgId,
    orgName: p.orgName,
    role: p.role,
    accessStatus: p.accessStatus,
  };
}

/** Mensagem amigável (§13) p/ o código de fraqueza de senha do core. */
function passwordMessage(reason: PasswordWeakReason): string {
  switch (reason) {
    case "too_short":
      return "A senha precisa de ao menos 8 caracteres.";
    case "no_letter":
      return "A senha precisa de ao menos uma letra.";
    case "no_number":
      return "A senha precisa de ao menos um número.";
  }
}

/**
 * Lógica de autenticação (sessão híbrida + argon2 + verificação de email — §12).
 * IO/senha/email vivem em ports; aqui só orquestração.
 */
export function createAuthService(deps: AuthDeps) {
  const clock = deps.now ?? (() => new Date());

  /** Hash argon2 fixo p/ equalizar timing quando o email não existe (anti-enumeração). */
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = (): Promise<string> => (dummyHash ??= deps.hasher.hash(generateSessionToken()));

  /** Cria a sessão server-side e devolve o token opaco (a casca põe no cookie). */
  async function issueSession(
    userId: string,
    orgId: string | null,
    ctx: SessionContext,
  ): Promise<string> {
    const rawToken = generateSessionToken();
    const now = clock();
    await deps.repo.createSession({
      userId,
      orgId,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: computeSessionExpiry(now),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      lastUsedAt: now,
    });
    return rawToken;
  }

  /** Emite um código de verificação e enfileira o email. */
  async function sendVerificationCode(userId: string | null, email: string): Promise<void> {
    const code = generateEmailCode();
    const now = clock();
    await deps.repo.issueOneTimeToken({
      userId,
      email,
      purpose: "email_verification",
      tokenHash: hashEmailCode(email, code),
      expiresAt: new Date(now.getTime() + deps.email.codeTtlMinutes * 60_000),
    });
    await deps.mailQueue.enqueue(buildVerificationEmail({ to: email, from: deps.email.from, code }));
  }

  return {
    /**
     * Signup (6b): cria a conta NÃO-verificada + manda o código. NÃO autentica.
     * Email já existente → resposta idêntica (anti-enum) + notifica o dono real.
     */
    async signup(input: SignupInput): Promise<SignupOutput> {
      // 1) validação de INPUT primeiro: senha fraca → 400 IDÊNTICO p/ email novo ou
      //    existente (senão o par existente+fraca vira oráculo de enumeração).
      const strength = checkPasswordStrength(input.password);
      if (!strength.ok) throw badRequest(passwordMessage(strength.reason));

      // 2) SEMPRE hasheia antes de ramificar: iguala o custo (~argon2) dos dois ramos
      //    → sem timing oracle de existência (o ramo "existe" pagava 0, o "novo" ~100ms).
      const passwordHash = await deps.hasher.hash(input.password);

      const existing = await deps.repo.findUserByEmail(input.email);
      if (existing) {
        await deps.mailQueue.enqueue(
          buildAccountExistsEmail({ to: input.email, from: deps.email.from, appUrl: deps.email.appUrl }),
        );
        return { pendingVerification: true };
      }

      try {
        const created = await deps.repo.createUserWithOrg({
          email: input.email,
          name: input.name,
          passwordHash,
          orgName: input.orgName,
        });
        await sendVerificationCode(created.userId, input.email);
      } catch (err) {
        // Corrida: dois signups concorrentes passam o pre-check e um bate no UNIQUE.
        // Anti-enum: responde idêntico + notifica o dono (não cria nada novo).
        if (isUniqueViolation(err)) {
          await deps.mailQueue.enqueue(
            buildAccountExistsEmail({ to: input.email, from: deps.email.from, appUrl: deps.email.appUrl }),
          );
          return { pendingVerification: true };
        }
        throw err;
      }
      return { pendingVerification: true };
    },

    /** Reenvio de código (sempre resolve — anti-enum; só age se houver user não-verificado). */
    async requestEmailCode(input: EmailCodeRequestInput): Promise<void> {
      const user = await deps.repo.findUserByEmail(input.email);
      if (user && !user.emailVerifiedAt) await sendVerificationCode(user.id, user.email);
    },

    /** Verifica o código: confirma o email E cria a sessão num passo. */
    async verifyEmailCode(input: EmailCodeVerifyInput, ctx: SessionContext): Promise<SessionIssued> {
      const invalid = badRequest("Código inválido ou expirado.");
      const token = await deps.repo.findUsableToken(
        "email_verification",
        hashEmailCode(input.email, input.code),
        clock(),
      );
      if (!token?.userId) throw invalid;
      const consumed = await deps.repo.consumeOneTimeToken(token.id);
      if (!consumed) throw invalid; // perdeu a corrida (já consumido)

      await deps.repo.markEmailVerified(token.userId);
      const principal = await deps.repo.loadPrincipal(token.userId);
      if (!principal) throw invalid;

      const rawToken = await issueSession(principal.userId, principal.orgId, ctx);
      return { rawToken, me: toMe(principal) };
    },

    async login(input: LoginInput, ctx: SessionContext): Promise<SessionIssued> {
      const user = await deps.repo.findUserByEmail(input.email);
      // Sempre roda um verify (hash real ou dummy) p/ não vazar existência por timing.
      const ok = await deps.hasher.verify(user?.passwordHash ?? (await getDummyHash()), input.password);
      if (!user || !ok) throw unauthorized("Credenciais inválidas");

      // Email não verificado: reenvia o código e sinaliza (front → tela de código).
      if (!user.emailVerifiedAt) {
        await sendVerificationCode(user.id, user.email);
        throw emailNotVerified();
      }

      const principal = await deps.repo.loadPrincipal(user.id);
      if (!principal) throw unauthorized("Credenciais inválidas");

      const rawToken = await issueSession(principal.userId, principal.orgId, ctx);
      return { rawToken, me: toMe(principal) };
    },

    /** Pede o link de reset (sempre resolve — anti-enum; só age se o email existir). */
    async forgotPassword(input: ForgotPasswordInput): Promise<void> {
      const user = await deps.repo.findUserByEmail(input.email);
      if (!user) return;
      const token = generateResetToken();
      const now = clock();
      await deps.repo.issueOneTimeToken({
        userId: user.id,
        email: user.email,
        purpose: "password_reset",
        tokenHash: hashOneTimeToken(token),
        expiresAt: new Date(now.getTime() + deps.email.resetTtlMinutes * 60_000),
      });
      const resetUrl = `${deps.email.appUrl}/reset-password?token=${token}`;
      await deps.mailQueue.enqueue(
        buildPasswordResetEmail({ to: user.email, from: deps.email.from, resetUrl }),
      );
    },

    /** Aplica a nova senha via token do link; revoga TODAS as outras sessões. */
    async resetPassword(input: ResetPasswordInput): Promise<void> {
      const invalid = badRequest("Link inválido ou expirado. Peça um novo.");
      const token = await deps.repo.findUsableToken(
        "password_reset",
        hashOneTimeToken(input.token),
        clock(),
      );
      if (!token?.userId) throw invalid;
      // valida a força ANTES de consumir (senha fraca não queima o link).
      const strength = checkPasswordStrength(input.password);
      if (!strength.ok) throw badRequest(passwordMessage(strength.reason));
      const consumed = await deps.repo.consumeOneTimeToken(token.id);
      if (!consumed) throw invalid;
      const passwordHash = await deps.hasher.hash(input.password);
      await deps.repo.updatePassword(token.userId, passwordHash);
      await deps.repo.revokeAllUserSessions(token.userId);
    },

    async logout(rawToken: string): Promise<void> {
      await deps.repo.revokeSession(hashSessionToken(rawToken));
    },

    async me(userId: string): Promise<MeOutput> {
      const principal = await deps.repo.loadPrincipal(userId);
      if (!principal) throw unauthorized();
      return toMe(principal);
    },

    /** Status do gate de acesso do usuário (guard do beta). null = sem grant. */
    async accessStatus(userId: string): Promise<"pending" | "active" | "revoked" | null> {
      return deps.repo.accessStatusByUserId(userId);
    },

    /** Valida o token do cookie → sessão ativa (desliza a expiração). Usado por `requireAuth`. */
    async resolveSession(rawToken: string): Promise<AuthenticatedUser | null> {
      const tokenHash = hashSessionToken(rawToken);
      const now = clock();
      const active = await deps.repo.findActiveSessionByHash(tokenHash, now);
      if (!active) return null;
      const staleFor = now.getTime() - (active.lastUsedAt?.getTime() ?? 0);
      if (staleFor > SESSION_SLIDE_THROTTLE_MS) {
        await deps.repo.slideSession(tokenHash, now, computeSessionExpiry(now));
      }
      return { userId: active.userId, orgId: active.orgId };
    },
  };
}
