import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../env.js";
import { unauthorized } from "../../middleware/error-handler.js";
import { evolutionWebhookBody, evolutionWebhookParams } from "./schema.js";

/**
 * Slice de webhooks (público, sem sessão). Valida EVOLUTION_WEBHOOK_SECRET
 * (§9/§12) antes de qualquer processamento; retorna 200 rápido (fila no worker).
 */
export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.webhooks;

  app.post("/webhooks/evolution/:instanceId", async (request, reply) => {
    const provided = request.headers["x-webhook-secret"];
    if (!isValidSecret(provided)) {
      throw unauthorized("Assinatura de webhook inválida");
    }

    const { instanceId } = evolutionWebhookParams.parse(request.params);
    const payload = evolutionWebhookBody.parse(request.body);

    const result = await service.handleEvolutionInbound(instanceId, payload);
    // 200 mesmo quando ignorado — não vaza se o contato/instância existe.
    return reply.status(200).send(result);
  });
};

/** Comparação em tempo constante contra timing attacks. */
function isValidSecret(provided: unknown): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(env.EVOLUTION_WEBHOOK_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}
