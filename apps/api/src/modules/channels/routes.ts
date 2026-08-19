import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Slice de canal: conectar instância (QR) + status. Opt-in de contato = slice contacts. */
export const channelsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.channels;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.post("/channels/connect", guard, async (request) => {
    return service.connect(orgIdOf(request));
  });

  app.get("/channels/status", guard, async (request) => {
    return service.status(orgIdOf(request));
  });
};
