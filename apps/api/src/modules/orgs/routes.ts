import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { createOrgInput } from "./schema.js";

/** Slice de orgs: listar orgs do user e criar nova (vira owner). */
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
};
