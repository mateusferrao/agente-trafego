import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Período "YYYY-MM" válido (01-12); malformado/ausente → mês corrente (evita Invalid Date). */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function resolvePeriod(raw: string | undefined): string {
  return raw && PERIOD_RE.test(raw) ? raw : new Date().toISOString().slice(0, 7);
}

/** Slice de billing: status de acesso ao produto e resumo de uso do período. */
export const billingRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.billing;
  // access-status/usage ficam SEM o gate (o front lê o status pra renderizar o muro).
  const guard = { preHandler: [requireAuth, requireOrgScope] };
  // painel de custos = feature do owner → gateado (não vaza COGS a acesso pendente).
  const gated = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.get("/billing/access-status", guard, async (request) => {
    return service.accessStatus(orgIdOf(request));
  });

  app.get("/billing/usage", guard, async (request) => {
    const { period } = request.query as { period?: string };
    return service.usage(orgIdOf(request), resolvePeriod(period));
  });

  // Painel de custos (owner): economia unitária por conta + total + gasto vs cap.
  app.get("/billing/costs", gated, async (request) => {
    const { period } = request.query as { period?: string };
    return service.costs(orgIdOf(request), resolvePeriod(period));
  });
};
