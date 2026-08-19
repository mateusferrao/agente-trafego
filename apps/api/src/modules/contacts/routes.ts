import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { startVerificationInput, confirmVerificationInput } from "./schema.js";

/**
 * Teto de tentativas nos endpoints de verificação (anti brute-force do código +
 * anti-abuso do outbound do WhatsApp — §9 throttle no proativo). Aplicado por-rota;
 * a invalidação do código após N tentativas (service) é a 2ª camada.
 */
const VERIFY_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };

/** Opt-in do contato por código (envia pelo WhatsApp, confirma no site). */
export const contactsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.contacts;
  const guard = {
    preHandler: [requireAuth, requireOrgScope],
    config: { rateLimit: VERIFY_RATE_LIMIT },
  };

  app.post("/contacts/verify/start", guard, async (request, reply) => {
    const input = startVerificationInput.parse(request.body);
    const result = await service.startVerification(orgIdOf(request), input);
    return reply.status(202).send(result);
  });

  app.post("/contacts/verify/confirm", guard, async (request) => {
    const input = confirmVerificationInput.parse(request.body);
    return service.confirmVerification(orgIdOf(request), input);
  });
};
