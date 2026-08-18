import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { connectTokenInput, selectAccountInput } from "./schema.js";

/**
 * Slice de contas Meta: conectar (cola token → lista contas), escolher conta,
 * listar contas conectadas. Todas org-scoped + autenticadas.
 */
export const accountsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.accounts;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  // Cola token → valida → lista contas acessíveis (cliente escolhe em seguida).
  app.post("/accounts/connect", guard, async (request) => {
    const input = connectTokenInput.parse(request.body);
    const accounts = await service.connectToken(orgIdOf(request), input);
    return { accounts };
  });

  // Escolhe a ad account e persiste o token cifrado (o token é reenviado do cliente).
  app.post("/accounts/select", guard, async (request, reply) => {
    const input = selectAccountInput.parse(request.body);
    const account = await service.selectAccount(orgIdOf(request), input);
    return reply.status(201).send(account);
  });

  app.get("/accounts", guard, async (request) => {
    return service.list(orgIdOf(request));
  });
};
