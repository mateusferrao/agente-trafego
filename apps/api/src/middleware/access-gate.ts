import type { FastifyReply, FastifyRequest } from "fastify";
import { accessPending, unauthorized } from "./error-handler.js";

/**
 * preHandler do gate de beta (6b): barra usuário cujo acesso não é `active`
 * (allowlist manual, keyed por email — §12). Aplicado às rotas de FEATURE
 * (não a `/auth/*`, `/me`, `/billing/access-status` — o front lê o status por
 * lá pra renderizar o muro "acesso pendente"). Roda após `requireAuth`.
 */
export async function requireActiveAccess(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.userId) throw unauthorized();
  const status = await request.server.container.services.auth.accessStatus(request.userId);
  if (status !== "active") throw accessPending();
}
