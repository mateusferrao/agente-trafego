import type { FastifyReply, FastifyRequest } from "fastify";
import type { OrgId } from "@trafego/shared/types";
import { forbidden } from "./error-handler.js";

/**
 * preHandler que resolve e fixa o `org_id` da requisição (multi-tenancy).
 * Toda query subsequente deve filtrar por este org_id — regra §12.
 * Roda depois de requireAuth.
 */
export async function requireOrgScope(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const orgId = request.session?.orgId;
  if (!orgId) {
    throw forbidden("Nenhuma org ativa na sessão");
  }
  // TODO: validar que request.userId tem membership na orgId (evita troca de tenant via cookie forjado).
  request.orgId = orgId as OrgId;
}

/** Helper para services: garante presença do org_id scoped (falha cedo se ausente). */
export function orgIdOf(request: FastifyRequest): OrgId {
  if (!request.orgId) {
    throw forbidden("org_id não resolvido — requireOrgScope não rodou?");
  }
  return request.orgId;
}
