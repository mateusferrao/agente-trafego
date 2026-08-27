import type { FastifyPluginAsync } from "fastify";
import type { OrgId } from "@trafego/shared/types";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { scaleWinnerInput } from "./schema.js";

/** Slice de rascunhos de campanha (Fatia 7): listar pendentes + escalar vencedor pelo site. */
export const draftsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.drafts;
  const guard = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.get("/drafts/pending", guard, async (request) => {
    return service.listPendingDrafts(orgIdOf(request) as OrgId);
  });

  app.post("/accounts/:id/drafts/scale", guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = scaleWinnerInput.parse(request.body);
    const result = await service.scaleWinner(orgIdOf(request) as OrgId, id, input);
    if (!result) return reply.status(404).send({ message: "conta ou agente não encontrado" });
    return result;
  });
};
