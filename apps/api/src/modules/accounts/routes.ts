import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/**
 * Slice de contas: lista as contas sob gestão da org. Conectar sistema externo +
 * escolher quais contas entram mora no slice `connections` (Integrações).
 */
export const accountsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.accounts;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.get("/accounts", guard, async (request) => {
    return service.list(orgIdOf(request));
  });
};
