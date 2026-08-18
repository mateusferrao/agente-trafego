import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { auditLog } from "@trafego/db";

/**
 * Cross-cutting §13: trilha de auditoria de TODO write org-scoped, num único
 * ponto na casca (nunca copiado por slice). Writes sem tenant (auth: signup/
 * login/logout) não têm `org_id` — ficam no log estruturado (pino) + na trilha
 * de sessão (`sessions.ip/ua/lastUsedAt`), não em `audit_log` (que é por-org).
 */
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Linha de auditoria a inserir; `typeof auditLog.$inferInsert` sem a PK/timestamps. */
export interface AuditEntry {
  readonly orgId: string;
  readonly actor: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Deriva a entrada de auditoria de uma resposta, ou `null` quando não se audita
 * (leitura, erro, ou write sem tenant). Puro/testável — o hook só insere.
 */
export function buildAuditEntry(request: FastifyRequest, reply: FastifyReply): AuditEntry | null {
  if (!WRITE_METHODS.has(request.method)) return null;
  if (reply.statusCode >= 400) return null;
  const orgId = request.orgId;
  if (!orgId) return null; // write sem tenant (auth) → não vai p/ audit_log

  const route = request.routeOptions?.url ?? request.url;
  return {
    orgId,
    actor: request.userId ? "user" : "system",
    actorUserId: request.userId ?? null,
    action: `${request.method} ${route}`,
    metadata: { statusCode: reply.statusCode, ip: request.ip },
  };
}

export function registerAudit(app: FastifyInstance): void {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const entry = buildAuditEntry(request, reply);
    if (!entry) return;
    try {
      await request.server.container.adapters.db.insert(auditLog).values(entry);
    } catch (err) {
      // auditoria nunca quebra a request (resposta já foi enviada) — só loga.
      request.log.error({ err, action: entry.action }, "falha ao gravar audit_log");
    }
  });
}

/**
 * Decorator opcional para marcar handlers que exigem auditoria explícita/rica
 * (ex: mutações Meta com before/after). No MVP a auditoria genérica cobre; casos
 * ricos anexam `before_state` no service. TODO(5a): implementar na escrita real.
 */
export function withAudit(route: RouteOptions): RouteOptions {
  return route;
}
