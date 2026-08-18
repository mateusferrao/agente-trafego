import type { FastifyReply, FastifyRequest } from "fastify";
import { unauthorized } from "./error-handler.js";

/**
 * preHandler que exige sessão autenticada (iron-session/@fastify/session).
 * Popula `request.userId`. Use em toda rota que não seja pública.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const userId = request.session?.userId;
  if (!userId) {
    throw unauthorized();
  }
  request.userId = userId;
  // TODO: opcional — carregar membership/role do user para checagens de RBAC.
}
