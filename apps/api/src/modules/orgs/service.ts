import type { CreateOrgInput, OrgOutput } from "./schema.js";
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
  };
}
