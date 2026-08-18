import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { createOrgInput, renameOrgInput } from "./schema.js";

/** Slice de orgs: listar orgs do user, criar nova (vira owner) e renomear a ativa. */
export const orgsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.orgs;

  app.get("/orgs", { preHandler: [requireAuth] }, async (request) => {
    return service.listForUser(request.userId!);
  });

  app.post("/orgs", { preHandler: [requireAuth] }, async (request, reply) => {
    const input = createOrgInput.parse(request.body);
    const org = await service.create(request.userId!, input);
    return reply.status(201).send(org);
  });

  // Renomeia a org ATIVA da sessão (org-scope valida membership; service exige owner).
  app.patch("/orgs/current", { preHandler: [requireAuth, requireOrgScope] }, async (request) => {
    const input = renameOrgInput.parse(request.body);
    return service.rename(request.userId!, orgIdOf(request), input);
  });
};
