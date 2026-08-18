import type { FastifyReply, FastifyRequest } from "fastify";
import type { OrgId } from "@trafego/shared/types";
import { forbidden, unauthorized } from "./error-handler.js";

/**
 * preHandler que fixa e **valida** o `org_id` da requisição (multi-tenancy).
 * A org ativa vem de requireAuth (sessão no DB) — nunca de header/input. Aqui
 * confirmamos que o user tem membership nela: sem isso, cookie forjado/estale
 * poderia agir sobre outro tenant. Toda query subsequente filtra por este org.
 */
export async function requireOrgScope(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.userId) throw unauthorized();
  const orgId = request.orgId;
  if (!orgId) throw forbidden("Nenhuma org ativa na sessão");

  const role = await request.server.container.services.orgs.membershipRole(request.userId, orgId);
  if (!role) throw forbidden("Sem acesso a esta organização");
}

/**
 * Resolve a org-alvo de uma operação, validando membership. Sem `candidate`,
 * usa a org ativa da sessão; com `candidate` (ex: agir sobre org específica),
 * exige membership nela. Centraliza o invariante "org_id nunca do cliente sem
 * checagem". Falha cedo se o user não pertence ao tenant.
 */
export async function resolveBusinessScope(
  request: FastifyRequest,
  candidate?: string,
): Promise<OrgId> {
  if (!request.userId) throw unauthorized();
  const target = candidate ?? request.orgId;
  if (!target) throw forbidden("Nenhuma org ativa na sessão");

  const role = await request.server.container.services.orgs.membershipRole(request.userId, target);
  if (!role) throw forbidden("Sem acesso a esta organização");
  return target as OrgId;
}

/** Helper para services: garante presença do org_id scoped (falha cedo se ausente). */
export function orgIdOf(request: FastifyRequest): OrgId {
  if (!request.orgId) {
    throw forbidden("org_id não resolvido — requireOrgScope não rodou?");
  }
  return request.orgId;
}
