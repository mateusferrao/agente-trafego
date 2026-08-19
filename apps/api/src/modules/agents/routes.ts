import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { agentGoalsInput, setPausedInput } from "./schema.js";

/**
 * Slice de agentes (3a): agente por conta (zero-config) + edição da meta.
 * Account-centric: o web conhece a conta, não o agentId.
 */
export const agentsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.agents;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.get("/accounts/:id/agent", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.getOrCreateForAccount(orgIdOf(request), id);
  });

  app.put("/accounts/:id/agent/goals", guard, async (request) => {
    const { id } = request.params as { id: string };
    const goals = agentGoalsInput.parse(request.body);
    return service.updateGoals(orgIdOf(request), id, goals);
  });

  app.put("/accounts/:id/agent/paused", guard, async (request) => {
    const { id } = request.params as { id: string };
    const { paused } = setPausedInput.parse(request.body);
    return service.setPaused(orgIdOf(request), id, paused);
  });
};
