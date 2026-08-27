import type { FastifyPluginAsync } from "fastify";
import type { OrgId } from "@trafego/shared/types";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { scaleWinnerInput, uploadCreativeInput } from "./schema.js";

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

  app.get("/accounts/:id/creatives", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.listCreatives(orgIdOf(request) as OrgId, id);
  });

  // bodyLimit maior: imagem em base64 (~1.3× o binário) estoura o default de 1MB.
  app.post("/accounts/:id/creatives/upload", { ...guard, bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = uploadCreativeInput.parse(request.body);
    const result = await service.uploadCreative(orgIdOf(request) as OrgId, id, input);
    if (!result) return reply.status(404).send({ message: "conta ou agente não encontrado" });
    return result;
  });
};
