import type { FastifyPluginAsync } from "fastify";
import type { RunId } from "@trafego/shared/types";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Slice de runs: disparo on-demand + último resultado (3a); histórico = 6a. */
export const runsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.runs;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  // 3a: "Analisar agora" + resultado no site.
  app.post("/accounts/:id/runs", guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await service.trigger(orgIdOf(request), id);
    return reply.status(202).send(result);
  });

  app.get("/accounts/:id/runs/latest", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.latest(orgIdOf(request), id);
  });

  // histórico/timeline (6a — mantido para compat do contrato)
  app.get("/runs", guard, async (request) => service.list(orgIdOf(request)));
  app.get("/runs/:id", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.timeline(orgIdOf(request), id as RunId);
  });
};
