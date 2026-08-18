import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Slice de billing: status da allowlist beta e resumo de uso do período. */
export const billingRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.billing;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.get("/billing/beta-access", guard, async (request) => {
    return service.betaAccess(orgIdOf(request));
  });

  app.get("/billing/usage", guard, async (request) => {
    const { period } = request.query as { period?: string };
    const yyyymm = period ?? new Date().toISOString().slice(0, 7);
    return service.usage(orgIdOf(request), yyyymm);
  });
};
