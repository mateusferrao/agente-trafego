import { and, eq } from "drizzle-orm";
import { memberships, orgs, type Database } from "@trafego/db";
import { orgSlug } from "./slug.js";
import type { OrgOutput } from "./schema.js";

export type MembershipRole = "owner" | "member";

/**
 * Porta de persistência do slice de orgs (tenancy). Concentra as queries de
 * membership — usadas tanto pelo service quanto pelo org-scoping (isolamento
 * de tenant). Adapter drizzle logo abaixo; service depende só da interface.
 */
export interface OrgsRepo {
  /** Orgs em que o user é membro (com o papel). Base do org-switcher. */
  listForUser(userId: string): Promise<OrgOutput[]>;
  /** Cria org + membership(owner) em transação; devolve a org já com o papel. */
  createWithOwner(userId: string, name: string): Promise<OrgOutput>;
  /** Papel do user na org, ou `null` se não for membro (check de isolamento). */
  findMembershipRole(userId: string, orgId: string): Promise<MembershipRole | null>;
  /** Renomeia a org (só o nome de exibição; slug intacto). Papel é composto no service. */
  rename(orgId: string, name: string): Promise<{ id: string; name: string }>;
}

export function createDrizzleOrgsRepo(db: Database): OrgsRepo {
  return {
    async listForUser(userId) {
      return db
        .select({ id: orgs.id, name: orgs.name, role: memberships.role })
        .from(memberships)
        .innerJoin(orgs, eq(memberships.orgId, orgs.id))
        .where(eq(memberships.userId, userId));
    },

    async createWithOwner(userId, name) {
      return db.transaction(async (tx) => {
        const [org] = await tx
          .insert(orgs)
          .values({ name, slug: orgSlug(name) })
          .returning({ id: orgs.id, name: orgs.name });
        if (!org) throw new Error("falha ao inserir org");
        await tx.insert(memberships).values({ orgId: org.id, userId, role: "owner" });
        return { id: org.id, name: org.name, role: "owner" };
      });
    },

    async findMembershipRole(userId, orgId) {
      const [row] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
        .limit(1);
      return row?.role ?? null;
    },

    async rename(orgId, name) {
      const [org] = await db
        .update(orgs)
        .set({ name })
        .where(eq(orgs.id, orgId))
        .returning({ id: orgs.id, name: orgs.name });
      if (!org) throw new Error("org não encontrada");
      return org;
    },
  };
}
