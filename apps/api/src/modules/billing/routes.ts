import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Período "YYYY-MM" válido (01-12); malformado/ausente → mês corrente (evita Invalid Date). */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function resolvePeriod(raw: string | undefined): string {
  return raw && PERIOD_RE.test(raw) ? raw : new Date().toISOString().slice(0, 7);
}

/** Dia "YYYY-MM-DD" válido. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** Resolve o range por dia (inclusivo). Ausente/malformado → últimos 30 dias. since>until → troca. */
function resolveRange(sinceRaw?: string, untilRaw?: string): { since: string; until: string } {
  const until = untilRaw && DAY_RE.test(untilRaw) ? untilRaw : isoDay(new Date());
  let since: string;
  if (sinceRaw && DAY_RE.test(sinceRaw)) {
    since = sinceRaw;
  } else {
    const d = new Date(`${until}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - (DEFAULT_RANGE_DAYS - 1));
    since = isoDay(d);
  }
  return since <= until ? { since, until } : { since: until, until: since };
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

  // Painel de custos (owner): range por dia (since/until) → total + série diária +
  // por conta + por tipo + gasto vs cap. Ausente → últimos 30 dias.
  app.get("/billing/costs", gated, async (request) => {
    const { since, until } = request.query as { since?: string; until?: string };
    const range = resolveRange(since, until);
    return service.costs(orgIdOf(request), range.since, range.until);
  });
};
