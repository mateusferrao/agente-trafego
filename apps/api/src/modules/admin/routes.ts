import type { FastifyPluginAsync } from "fastify";
import { env } from "../../env.js";
import { makeRequireAdminSecret } from "../../middleware/admin-secret.js";
import { connectAccountInput, runParams } from "./schema.js";

/**
 * Slice admin (Fatia 0): colar token + disparar análise. Guardado por header
 * `x-admin-secret` (sem sessão) — fora do /api, some quando a 1a trouxer auth.
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.admin;
  const guard = { preHandler: [makeRequireAdminSecret(env.BETA_ADMIN_SECRET)] };

  app.post("/admin/accounts", guard, async (request, reply) => {
    const input = connectAccountInput.parse(request.body);
    const result = await service.connectAccount(input);
    return reply.status(201).send(result);
  });

  app.post("/admin/accounts/:id/run", guard, async (request, reply) => {
    const { id } = runParams.parse(request.params);
    await service.triggerRun(id);
    return reply.status(202).send({ status: "enqueued", accountId: id });
  });
};
