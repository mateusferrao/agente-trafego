import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { setGroupInput } from "./schema.js";

/** Slice de registro do grupo WhatsApp (G4) — espelha `channels` (número). */
export const groupsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.groups;
  const guard = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.get("/channels/groups", guard, async (request) => {
    return service.list(orgIdOf(request));
  });

  app.put("/channels/group", guard, async (request) => {
    const input = setGroupInput.parse(request.body);
    return service.set(orgIdOf(request), input);
  });

  app.delete("/channels/group", guard, async (request) => {
    return service.disable(orgIdOf(request));
  });
};
