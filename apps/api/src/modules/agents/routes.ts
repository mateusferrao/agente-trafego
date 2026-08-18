import type { FastifyPluginAsync } from "fastify";
import type { AgentId } from "@trafego/shared/types";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { createAgentInput, updateAgentInput } from "./schema.js";

/** Slice de agentes: criar (por arquétipo), ler e editar config. */
export const agentsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.agents;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.get("/agents/:id", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.get(orgIdOf(request), id as AgentId);
  });

  app.post("/agents", guard, async (request, reply) => {
    const input = createAgentInput.parse(request.body);
    const agent = await service.create(orgIdOf(request), input);
    return reply.status(201).send(agent);
  });

  app.patch("/agents/:id", guard, async (request) => {
    const { id } = request.params as { id: string };
    const input = updateAgentInput.parse(request.body);
    return service.update(orgIdOf(request), id as AgentId, input);
  });
};
