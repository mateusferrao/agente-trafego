import { and, eq, gt, isNull } from "drizzle-orm";
import {
  accessGrants,
  memberships,
  orgs,
  sessions,
  users,
  type Database,
} from "@trafego/db";
import { orgSlug } from "../orgs/slug.js";

/** Linha de usuário para autenticação (inclui o hash — nunca exposto ao cliente). */
export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly passwordHash: string;
}

/** Principal completo (user + org ativa + papel + status de beta) p/ o `MeOutput`. */
export interface PrincipalRow {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly role: "owner" | "member" | null;
  readonly accessStatus: "pending" | "active" | "revoked" | null;
}

export interface CreateUserWithOrgParams {
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly orgName: string;
}

export interface CreateUserWithOrgResult {
  readonly userId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly role: "owner";
  readonly accessStatus: "pending";
}

export interface CreateSessionParams {
  readonly userId: string;
  readonly orgId: string | null;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly lastUsedAt: Date;
}

/** Sessão ativa resolvida a partir do hash do token do cookie. */
export interface ActiveSession {
  readonly userId: string;
  readonly orgId: string | null;
  /** Último uso registrado (base do throttle do slide). */
  readonly lastUsedAt: Date | null;
}

/**
 * Porta de persistência do slice de auth. O service depende só desta interface
 * (desacoplado do drizzle); o adapter concreto vive logo abaixo. Isola a
 * orquestração testável do IO real (tx multi-tabela + joins).
 */
export interface AuthRepo {
  findUserByEmail(email: string): Promise<UserRow | null>;
  createUserWithOrg(params: CreateUserWithOrgParams): Promise<CreateUserWithOrgResult>;
  loadPrincipal(userId: string): Promise<PrincipalRow | null>;
  createSession(params: CreateSessionParams): Promise<void>;
  findActiveSessionByHash(tokenHash: string, now: Date): Promise<ActiveSession | null>;
  /** Expiração deslizante: marca uso e empurra `expiresAt` a cada request autenticado. */
  slideSession(tokenHash: string, lastUsedAt: Date, expiresAt: Date): Promise<void>;
  revokeSession(tokenHash: string): Promise<void>;
}

/** Adapter drizzle da `AuthRepo`. Toda query é escopada por chave própria. */
export function createDrizzleAuthRepo(db: Database): AuthRepo {
  return {
    async findUserByEmail(email) {
      const [row] = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return row ?? null;
    },

    async createUserWithOrg(params) {
      return db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email: params.email,
            name: params.name,
            passwordHash: params.passwordHash,
          })
          .returning({ id: users.id });
        if (!user) throw new Error("falha ao inserir user");

        const [org] = await tx
          .insert(orgs)
          .values({ name: params.orgName, slug: orgSlug(params.orgName) })
          .returning({ id: orgs.id, name: orgs.name });
        if (!org) throw new Error("falha ao inserir org");

        await tx.insert(memberships).values({
          orgId: org.id,
          userId: user.id,
          role: "owner",
        });

        // Gate de acesso: registra o email como pendente (idempotente). Signup é
        // livre no MVP; o ENFORCEMENT do gate (bloquear pending/revoked) é nas
        // RUNS do agente (3a), não no acesso à API — decisão de produto (§2/§8).
        await tx
          .insert(accessGrants)
          .values({ email: params.email, status: "pending" })
          .onConflictDoNothing({ target: accessGrants.email });

        return {
          userId: user.id,
          orgId: org.id,
          orgName: org.name,
          role: "owner" as const,
          accessStatus: "pending" as const,
        };
      });
    },

    async loadPrincipal(userId) {
      const [user] = await db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) return null;

      const [membership] = await db
        .select({ orgId: orgs.id, orgName: orgs.name, role: memberships.role })
        .from(memberships)
        .innerJoin(orgs, eq(memberships.orgId, orgs.id))
        .where(eq(memberships.userId, userId))
        // determinístico com múltiplas orgs: a mais antiga (org default do user).
        .orderBy(memberships.createdAt)
        .limit(1);

      const [access] = await db
        .select({ status: accessGrants.status })
        .from(accessGrants)
        .where(eq(accessGrants.email, user.email))
        .limit(1);

      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        orgId: membership?.orgId ?? null,
        orgName: membership?.orgName ?? null,
        role: membership?.role ?? null,
        accessStatus: access?.status ?? null,
      };
    },

    async createSession(params) {
      await db.insert(sessions).values({
        userId: params.userId,
        orgId: params.orgId,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        lastUsedAt: params.lastUsedAt,
      });
    },

    async findActiveSessionByHash(tokenHash, now) {
      const [row] = await db
        .select({
          userId: sessions.userId,
          orgId: sessions.orgId,
          lastUsedAt: sessions.lastUsedAt,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async slideSession(tokenHash, lastUsedAt, expiresAt) {
      await db
        .update(sessions)
        .set({ lastUsedAt, expiresAt })
        // reafirma não-revogada (defense-in-depth contra refactor futuro).
        .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
    },

    async revokeSession(tokenHash) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
    },
  };
}
