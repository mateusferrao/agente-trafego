import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Slice de billing: status de acesso ao produto e resumo de uso do período. */
export const billingRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.billing;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.get("/billing/access-status", guard, async (request) => {
    return service.accessStatus(orgIdOf(request));
  });

  app.get("/billing/usage", guard, async (request) => {
    const { period } = request.query as { period?: string };
    const yyyymm = period ?? new Date().toISOString().slice(0, 7);
    return service.usage(orgIdOf(request), yyyymm);
  });
};
