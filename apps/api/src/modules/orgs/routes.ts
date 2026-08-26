import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { createOrgInput, renameOrgInput, setMarketReferenceInput, setTimezoneInput } from "./schema.js";

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

  // Org ativa (nome + fuso) — base da tela de Configurações.
  app.get("/orgs/current", { preHandler: [requireAuth, requireOrgScope] }, async (request) => {
    return service.getCurrent(request.userId!, orgIdOf(request));
  });

  // Fuso da org ATIVA (Fatia 4) — só o owner. Usado p/ avaliar a cadência.
  app.patch("/orgs/current/timezone", { preHandler: [requireAuth, requireOrgScope] }, async (request) => {
    const input = setTimezoneInput.parse(request.body);
    return service.setTimezone(request.userId!, orgIdOf(request), input);
  });

  // Referência de mercado padrão da org (pivô) — leitura p/ membro, escrita só owner.
  app.get("/orgs/current/market-reference", { preHandler: [requireAuth, requireOrgScope] }, async (request) => {
    return service.getMarketReference(request.userId!, orgIdOf(request));
  });

  app.put("/orgs/current/market-reference", { preHandler: [requireAuth, requireOrgScope] }, async (request) => {
    const input = setMarketReferenceInput.parse(request.body);
    return service.setMarketReference(request.userId!, orgIdOf(request), input);
  });
};
