import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Aba "Aprendizados" (S1, read-only): lista as lições curadas de um agente. */
export const learningsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.learnings;
  const guard = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.get("/agents/:agentId/learnings", guard, async (request) => {
    const { agentId } = request.params as { agentId: string };
    return service.list(orgIdOf(request), agentId);
  });
};
