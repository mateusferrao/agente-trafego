import type { Database } from "@trafego/db";
import type { CreateOrgInput, OrgOutput } from "./schema.js";

export interface OrgsDeps {
  readonly db: Database;
}

/** Slice de orgs (tenants). Cria org + membership owner; lista orgs do user. */
export function createOrgsService(deps: OrgsDeps) {
  return {
    async listForUser(_userId: string): Promise<OrgOutput[]> {
      // TODO: join memberships → orgs filtrando por user.
      void deps.db;
      return [];
    },

    async create(_userId: string, _input: CreateOrgInput): Promise<OrgOutput> {
      // TODO: inserir org + membership(role=owner) em transação.
      throw new Error("TODO: implementar create org");
    },
  };
}
