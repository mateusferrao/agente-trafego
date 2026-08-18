import "fastify";
import type { OrgId } from "@trafego/shared/types";
import type { Container } from "../composition.js";

// Augmentação do Fastify: container + contexto scoped (user/org) da sessão híbrida.
declare module "fastify" {
  interface FastifyInstance {
    /** Container montado na composition root, disponível nas rotas. */
    readonly container: Container;
  }
  interface FastifyRequest {
    /** org_id resolvido pelo middleware de scoping (garante isolamento tenant). */
    orgId?: OrgId;
    /** user autenticado resolvido por requireAuth (cookie → sessão no DB). */
    userId?: string;
  }
}
