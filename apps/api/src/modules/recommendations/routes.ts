import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { feedbackInput } from "./schema.js";

/** Feedback 👍/👎 numa recomendação (site). */
export const recommendationsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.recommendations;
  const guard = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.post("/recommendations/:id/feedback", guard, async (request) => {
    const { id } = request.params as { id: string };
    const input = feedbackInput.parse(request.body);
    return service.feedback(orgIdOf(request), id, input);
  });
};
