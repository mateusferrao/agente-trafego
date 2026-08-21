import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import type { TimelineOptions } from "./service.js";

/** Slice da Timeline (6a): feed de auditoria por conta (paginado + filtros). */
export const timelineRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.timeline;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.get("/accounts/:id/timeline", guard, async (request) => {
    const { id } = request.params as { id: string };
    const q = request.query as { types?: string; since?: string; limit?: string; offset?: string };
    const types = q.types?.split(",").map((t) => t.trim()).filter(Boolean);
    const limit = toInt(q.limit, 1);
    const offset = toInt(q.offset, 0);
    const since = q.since && !Number.isNaN(Date.parse(q.since)) ? q.since : undefined;
    const opts: TimelineOptions = {
      ...(types && types.length > 0 ? { types } : {}),
      ...(since ? { since } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    };
    return service.timeline(orgIdOf(request), id, opts);
  });
};

function toInt(v: string | undefined, min: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : undefined;
}
