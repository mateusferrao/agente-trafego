import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { verifyContactInput } from "./schema.js";

/** Slice de canal: conectar instância (QR), status, verificar contato. */
export const channelsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.channels;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.post("/channels/connect", guard, async (request) => {
    return service.connect(orgIdOf(request));
  });

  app.get("/channels/status", guard, async (request) => {
    return service.status(orgIdOf(request));
  });

  app.post("/channels/verify-contact", guard, async (request, reply) => {
    const input = verifyContactInput.parse(request.body);
    const result = await service.verifyContact(orgIdOf(request), input);
    return reply.status(202).send(result);
  });
};
