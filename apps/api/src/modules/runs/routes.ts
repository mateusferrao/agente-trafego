import type { FastifyPluginAsync } from "fastify";
import type { RunId } from "@trafego/shared/types";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Slice de runs: histórico e timeline de um run. Somente leitura. */
export const runsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.runs;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.get("/runs", guard, async (request) => {
    return service.list(orgIdOf(request));
  });

  app.get("/runs/:id", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.timeline(orgIdOf(request), id as RunId);
  });
};
