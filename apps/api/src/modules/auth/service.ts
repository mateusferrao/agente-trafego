import { conflict, unauthorized } from "../../middleware/error-handler.js";
import type { PasswordHasher } from "./password.js";
import type { AuthRepo, PrincipalRow } from "./repo.js";
import {
  computeSessionExpiry,
  generateSessionToken,
  hashSessionToken,
  SESSION_SLIDE_THROTTLE_MS,
} from "./session-token.js";
import type { LoginInput, MeOutput, SignupInput } from "./schema.js";

export interface AuthDeps {
  readonly repo: AuthRepo;
  readonly hasher: PasswordHasher;
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
 * Resultado de signup/login: o token opaco (vai p/ o cookie, a casca sela o
 * contexto) + o `MeOutput` (corpo da resposta). O service não conhece cookies.
 */
export interface SessionIssued {
  readonly rawToken: string;
  readonly me: MeOutput;
}

/** Erro de violação de UNIQUE do Postgres (ex: corrida de signup no mesmo email). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
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

/**
 * Lógica de autenticação (sessão híbrida + argon2 — §12). Verifica credencial,
 * cria a sessão server-side (token opaco → hash no DB) e devolve o principal.
 * IO/senha vivem em ports (`AuthRepo`/`PasswordHasher`); aqui só orquestração.
 */
export function createAuthService(deps: AuthDeps) {
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
    const now = new Date();
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

  return {
    async signup(input: SignupInput, ctx: SessionContext): Promise<SessionIssued> {
      const existing = await deps.repo.findUserByEmail(input.email);
      if (existing) throw conflict("E-mail já cadastrado");

      const passwordHash = await deps.hasher.hash(input.password);
      let created;
      try {
        created = await deps.repo.createUserWithOrg({
          email: input.email,
          name: input.name,
          passwordHash,
          orgName: input.orgName,
        });
      } catch (err) {
        // Corrida: dois signups concorrentes passam o pre-check e um bate no
        // UNIQUE de users.email → 409 (não 500). O pre-check acima é o fast-path.
        if (isUniqueViolation(err)) throw conflict("E-mail já cadastrado");
        throw err;
      }

      const rawToken = await issueSession(created.userId, created.orgId, ctx);
      return {
        rawToken,
        me: {
          userId: created.userId,
          email: input.email,
          name: input.name,
          orgId: created.orgId,
          orgName: created.orgName,
          role: created.role,
          accessStatus: created.accessStatus,
        },
      };
    },

    async login(input: LoginInput, ctx: SessionContext): Promise<SessionIssued> {
      const user = await deps.repo.findUserByEmail(input.email);
      // Sempre roda um verify (hash real ou dummy) p/ não vazar existência por timing.
      const ok = await deps.hasher.verify(user?.passwordHash ?? (await getDummyHash()), input.password);
      if (!user || !ok) throw unauthorized("Credenciais inválidas");

      const principal = await deps.repo.loadPrincipal(user.id);
      if (!principal) throw unauthorized("Credenciais inválidas");

      const rawToken = await issueSession(principal.userId, principal.orgId, ctx);
      return { rawToken, me: toMe(principal) };
    },

    async logout(rawToken: string): Promise<void> {
      await deps.repo.revokeSession(hashSessionToken(rawToken));
    },

    async me(userId: string): Promise<MeOutput> {
      const principal = await deps.repo.loadPrincipal(userId);
      if (!principal) throw unauthorized();
      return toMe(principal);
    },

    /** Valida o token do cookie → sessão ativa (desliza a expiração). Usado por `requireAuth`. */
    async resolveSession(rawToken: string): Promise<AuthenticatedUser | null> {
      const tokenHash = hashSessionToken(rawToken);
      const now = new Date();
      const active = await deps.repo.findActiveSessionByHash(tokenHash, now);
      if (!active) return null;
      // Slide throttlado: só reescreve se o último uso foi há mais que o limite
      // (evita um UPDATE por request autenticado).
      const staleFor = now.getTime() - (active.lastUsedAt?.getTime() ?? 0);
      if (staleFor > SESSION_SLIDE_THROTTLE_MS) {
        await deps.repo.slideSession(tokenHash, now, computeSessionExpiry(now));
      }
      return { userId: active.userId, orgId: active.orgId };
    },
  };
}
