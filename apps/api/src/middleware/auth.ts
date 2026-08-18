import type { FastifyReply, FastifyRequest } from "fastify";
import type { OrgId } from "@trafego/shared/types";
import { SESSION_TOKEN_COOKIE } from "../http/cookies.js";
import { unauthorized } from "./error-handler.js";

/**
 * preHandler que exige sessão autenticada (sessão híbrida): lê o token opaco do
 * cookie → resolve contra o DB (não-revogada + não-expirada) → popula
 * `request.userId`/`request.orgId`. Rota sem este guard = pública.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = request.cookies?.[SESSION_TOKEN_COOKIE];
  if (!token) throw unauthorized();

  const session = await request.server.container.services.auth.resolveSession(token);
  if (!session) throw unauthorized();

  request.userId = session.userId;
  if (session.orgId) request.orgId = session.orgId as OrgId;
}
