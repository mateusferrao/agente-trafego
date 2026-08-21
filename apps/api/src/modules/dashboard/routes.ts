import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Slice do Painel (6a): KPIs ao vivo por conta + "atualizar agora" (sync-only). */
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.dashboard;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  // Painel gerencial cross-conta (home): pendências + atenção + atividade + panorama.
  app.get("/dashboard", guard, async (request) => {
    return service.dashboard(orgIdOf(request));
  });

  // Lista rica de contas (roster informativo — tela Contas): panorama completo.
  app.get("/accounts/panorama", guard, async (request) => {
    return { accounts: await service.panorama(orgIdOf(request)) };
  });

  // KPIs ao vivo de uma conta (computados do insights_snapshots) + as-of.
  app.get("/accounts/:id/live-metrics", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.liveMetrics(orgIdOf(request), id);
  });

  // "Atualizar agora": força um sync-only (sem análise/LLM).
  app.post("/accounts/:id/refresh-data", guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await service.requestRefresh(orgIdOf(request), id);
    return reply.status(202).send(result);
  });
};
