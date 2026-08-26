import { and, eq } from "drizzle-orm";
import { memberships, orgs, type Database } from "@trafego/db";
import type { MarketReference } from "@trafego/shared";
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
  rename(orgId: string, name: string): Promise<{ id: string; name: string; timezone: string }>;
  /** Atualiza o fuso da org (papel composto no service). */
  setTimezone(orgId: string, timezone: string): Promise<{ id: string; name: string; timezone: string }>;
  /** Org por id (nome+fuso) — base do GET /orgs/current. */
  findById(orgId: string): Promise<{ id: string; name: string; timezone: string } | null>;
  /** Referência de mercado padrão da org (null = não configurada). */
  getMarketReference(orgId: string): Promise<MarketReference | null>;
  /** Grava (ou limpa com null) a referência de mercado padrão da org. */
  setMarketReference(orgId: string, ref: MarketReference | null): Promise<void>;
}

export function createDrizzleOrgsRepo(db: Database): OrgsRepo {
  return {
    async listForUser(userId) {
      return db
        .select({ id: orgs.id, name: orgs.name, role: memberships.role, timezone: orgs.timezone })
        .from(memberships)
        .innerJoin(orgs, eq(memberships.orgId, orgs.id))
        .where(eq(memberships.userId, userId));
    },

    async createWithOwner(userId, name) {
      return db.transaction(async (tx) => {
        const [org] = await tx
          .insert(orgs)
          .values({ name, slug: orgSlug(name) })
          .returning({ id: orgs.id, name: orgs.name, timezone: orgs.timezone });
        if (!org) throw new Error("falha ao inserir org");
        await tx.insert(memberships).values({ orgId: org.id, userId, role: "owner" });
        return { id: org.id, name: org.name, role: "owner", timezone: org.timezone };
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
        .returning({ id: orgs.id, name: orgs.name, timezone: orgs.timezone });
      if (!org) throw new Error("org não encontrada");
      return org;
    },

    async setTimezone(orgId, timezone) {
      const [org] = await db
        .update(orgs)
        .set({ timezone })
        .where(eq(orgs.id, orgId))
        .returning({ id: orgs.id, name: orgs.name, timezone: orgs.timezone });
      if (!org) throw new Error("org não encontrada");
      return org;
    },

    async findById(orgId) {
      const [org] = await db
        .select({ id: orgs.id, name: orgs.name, timezone: orgs.timezone })
        .from(orgs)
        .where(eq(orgs.id, orgId))
        .limit(1);
      return org ?? null;
    },

    async getMarketReference(orgId) {
      const [org] = await db
        .select({ marketReference: orgs.marketReference })
        .from(orgs)
        .where(eq(orgs.id, orgId))
        .limit(1);
      return org?.marketReference ?? null;
    },

    async setMarketReference(orgId, ref) {
      await db.update(orgs).set({ marketReference: ref }).where(eq(orgs.id, orgId));
    },
  };
}
