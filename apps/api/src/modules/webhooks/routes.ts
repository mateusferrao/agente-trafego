import type { FastifyPluginAsync } from "fastify";
import { evolutionWebhookBody, evolutionWebhookParams } from "./schema.js";

/**
 * Slice de webhooks (público, sem sessão). Valida o secret POR-INSTÂNCIA
 * (`channel_instances.webhook_secret`, §9/§12) no service; retorna 200 rápido
 * (o processamento roda no worker via fila).
 */
export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.webhooks;

  app.post("/webhooks/evolution/:instanceId", async (request, reply) => {
    const { instanceId } = evolutionWebhookParams.parse(request.params);
    const payload = evolutionWebhookBody.parse(request.body);
    const providedSecret = request.headers["x-webhook-secret"];

    // secret inválido → 401 no service (não vaza se a instância existe).
    const result = await service.handleEvolutionInbound(instanceId, providedSecret, payload);
    return reply.status(200).send(result);
  });
};
