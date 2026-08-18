import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { loginInput } from "./schema.js";

/** Slice de auth: login/logout/me. Rotas públicas + `me` protegida. */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.auth;

  app.post("/auth/login", async (request, reply) => {
    const input = loginInput.parse(request.body);
    const user = await service.login(input);
    request.session.userId = user.userId;
    if (user.orgId) request.session.orgId = user.orgId;
    return reply.send({ ok: true });
  });

  app.post("/auth/logout", async (request, reply) => {
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  app.get("/auth/me", { preHandler: [requireAuth] }, async (request) => {
    return service.me(request.userId!);
  });
};
