import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";

/**
 * Cross-cutting §13: auditoria + metering em TODO write, num único ponto na
 * casca (nunca copiado por slice). Escutamos respostas de rotas mutadoras
 * (POST/PATCH/PUT/DELETE 2xx) e gravamos audit_log + usage_events.
 */
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function registerAudit(app: FastifyInstance): void {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!WRITE_METHODS.has(request.method)) return;
    if (reply.statusCode >= 400) return;

    // TODO: gravar audit_log(actor=userId, action=method+routerPath, target, before/after)
    //       via container/db, e metering.record({ type: "api_write", ... }) scoped por org.
    request.log.debug(
      { orgId: request.orgId, userId: request.userId, route: request.routeOptions?.url },
      "audit+metering write (stub)",
    );
  });
}

/**
 * Decorator opcional para marcar handlers que exigem auditoria explícita/rica
 * (ex: mutações Meta). No MVP a auditoria genérica cobre; casos ricos anexam
 * `before_state` no service. TODO: implementar quando houver escrita real.
 */
export function withAudit(route: RouteOptions): RouteOptions {
  return route;
}
