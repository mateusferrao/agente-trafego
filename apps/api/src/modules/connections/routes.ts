import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { connectionParams, createConnectionInput, selectAccountsInput } from "./schema.js";

/**
 * Slice de conexões com sistemas externos (Meta hoje): conectar (cola token →
 * cria a conexão dona do token), listar, ver/gerir contas e sincronizar. Tudo
 * org-scoped + autenticado. A conta de anúncio vira gerível a partir daqui.
 */
export const connectionsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.connections;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  // Cola token → valida → cria a conexão e devolve as contas p/ escolher já.
  app.post("/connections", guard, async (request, reply) => {
    const input = createConnectionInput.parse(request.body);
    const result = await service.create(orgIdOf(request), input);
    return reply.status(201).send(result);
  });

  app.get("/connections", guard, async (request) => {
    return service.list(orgIdOf(request));
  });

  app.get("/connections/:id/accounts", guard, async (request) => {
    const { id } = connectionParams.parse(request.params);
    return service.accounts(orgIdOf(request), id);
  });

  // Multi-seleção do dono: quais contas ficam ativas (ativa/soft-remove).
  app.post("/connections/:id/accounts/select", guard, async (request) => {
    const { id } = connectionParams.parse(request.params);
    const input = selectAccountsInput.parse(request.body);
    return service.select(orgIdOf(request), id, input);
  });

  // Redescobre contas na plataforma e reconcilia (aditivo/não-destrutivo).
  app.post("/connections/:id/sync", guard, async (request) => {
    const { id } = connectionParams.parse(request.params);
    return service.sync(orgIdOf(request), id);
  });
};
