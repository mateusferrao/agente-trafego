import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import type { ListRunsOptions } from "./service.js";

/** Slice de runs: disparo on-demand + último resultado (3a); histórico = 6a. */
export const runsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.runs;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  // 3a: "Analisar agora" + resultado no site.
  app.post("/accounts/:id/runs", guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await service.trigger(orgIdOf(request), id);
    return reply.status(202).send(result);
  });

  app.get("/accounts/:id/runs/latest", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.latest(orgIdOf(request), id);
  });

  // recorte por campanha do resultado atual (cartões por campanha no site).
  app.get("/accounts/:id/campaign-analyses", guard, async (request) => {
    const { id } = request.params as { id: string };
    const campaigns = await service.campaignAnalyses(orgIdOf(request), id);
    return { campaigns };
  });

  // histórico de análises da conta (6a): lista paginada + filtros (nota/período).
  app.get("/accounts/:id/runs", guard, async (request) => {
    const { id } = request.params as { id: string };
    const q = request.query as {
      grades?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
    const grades = q.grades?.split(",").map((g) => g.trim()).filter(Boolean);
    const limit = toInt(q.limit, 1);
    const offset = toInt(q.offset, 0);
    const since = toIsoDate(q.since);
    const until = toIsoDate(q.until);
    const opts: ListRunsOptions = {
      ...(grades && grades.length > 0 ? { grades } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    };
    return service.listRuns(orgIdOf(request), id, opts);
  });

  // detalhe de UM run (histórico): note que `latest` (estático) tem prioridade sobre `:runId`.
  app.get("/accounts/:id/runs/:runId", guard, async (request) => {
    const { id, runId } = request.params as { id: string; runId: string };
    return service.runDetail(orgIdOf(request), id, runId);
  });
};

/** Inteiro ≥ min vindo da query (descarta não-numérico/NaN → undefined = usa default). */
function toInt(v: string | undefined, min: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : undefined;
}

/** Data ISO válida da query (descarta data inválida → undefined = sem filtro). */
function toIsoDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return Number.isNaN(Date.parse(v)) ? undefined : v;
}
