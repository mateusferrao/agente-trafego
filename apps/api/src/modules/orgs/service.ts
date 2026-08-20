import { forbidden, notFound } from "../../middleware/error-handler.js";
import type { CreateOrgInput, OrgOutput, RenameOrgInput, SetTimezoneInput } from "./schema.js";
import type { MembershipRole, OrgsRepo } from "./repo.js";

export interface OrgsDeps {
  readonly repo: OrgsRepo;
}

/** Slice de orgs (tenants). Lista orgs do user; cria org + membership owner. */
export function createOrgsService(deps: OrgsDeps) {
  return {
    listForUser(userId: string): Promise<OrgOutput[]> {
      return deps.repo.listForUser(userId);
    },

    create(userId: string, input: CreateOrgInput): Promise<OrgOutput> {
      return deps.repo.createWithOwner(userId, input.name);
    },

    /** Papel do user na org (null = não-membro). Base do org-scoping/isolamento. */
    membershipRole(userId: string, orgId: string): Promise<MembershipRole | null> {
      return deps.repo.findMembershipRole(userId, orgId);
    },

    /** Renomeia a org ativa. Só o owner pode; membro é barrado (403). */
    async rename(userId: string, orgId: string, input: RenameOrgInput): Promise<OrgOutput> {
      const role = await deps.repo.findMembershipRole(userId, orgId);
      if (role !== "owner") throw forbidden("Só o dono pode renomear a organização");
      const org = await deps.repo.rename(orgId, input.name);
      return { ...org, role };
    },

    /** Org ativa (nome + fuso) da sessão — base da tela de Configurações. */
    async getCurrent(userId: string, orgId: string): Promise<OrgOutput> {
      const role = await deps.repo.findMembershipRole(userId, orgId);
      if (!role) throw forbidden("Você não é membro desta organização");
      const org = await deps.repo.findById(orgId);
      if (!org) throw notFound("Organização não encontrada");
      return { ...org, role };
    },

    /** Muda o fuso da org ativa. Só o owner pode; membro é barrado (403). */
    async setTimezone(userId: string, orgId: string, input: SetTimezoneInput): Promise<OrgOutput> {
      const role = await deps.repo.findMembershipRole(userId, orgId);
      if (role !== "owner") throw forbidden("Só o dono pode mudar o fuso horário");
      const org = await deps.repo.setTimezone(orgId, input.timezone);
      return { ...org, role };
    },
  };
}
