import "fastify";
import "@fastify/session";
import type { OrgId } from "@trafego/shared/types";
import type { Container } from "../composition.js";

// Augmentação do Fastify: sessão custom + container + contexto scoped por org.
declare module "fastify" {
  interface FastifyInstance {
    /** Container montado na composition root, disponível nas rotas. */
    readonly container: Container;
  }
  interface FastifyRequest {
    /** org_id resolvido pelo middleware de scoping (garante isolamento tenant). */
    orgId?: OrgId;
    /** user autenticado resolvido por requireAuth. */
    userId?: string;
  }
}

declare module "@fastify/session" {
  interface FastifySessionObject {
    userId?: string;
    orgId?: string;
  }
}
