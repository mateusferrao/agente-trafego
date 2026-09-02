import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { editLearningInput } from "./schema.js";

/** Aba "Aprendizados": listar (read) + editar/confirmar/esquecer (S5). */
export const learningsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.learnings;
  const guard = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.get("/agents/:agentId/learnings", guard, async (request) => {
    const { agentId } = request.params as { agentId: string };
    return service.list(orgIdOf(request), agentId);
  });

  app.patch("/agents/:agentId/learnings/:id", guard, async (request) => {
    const { agentId, id } = request.params as { agentId: string; id: string };
    const input = editLearningInput.parse(request.body);
    return service.edit(orgIdOf(request), agentId, id, input.content);
  });

  app.post("/agents/:agentId/learnings/:id/confirm", guard, async (request) => {
    const { agentId, id } = request.params as { agentId: string; id: string };
    return service.confirm(orgIdOf(request), agentId, id);
  });

  app.delete("/agents/:agentId/learnings/:id", guard, async (request) => {
    const { agentId, id } = request.params as { agentId: string; id: string };
    return service.forget(orgIdOf(request), agentId, id);
  });

  app.post("/agents/:agentId/learnings/:id/accept-threshold", guard, async (request) => {
    const { agentId, id } = request.params as { agentId: string; id: string };
    return service.acceptThreshold(orgIdOf(request), agentId, id);
  });
};
