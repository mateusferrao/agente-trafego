import type { FastifyPluginAsync } from "fastify";
import { env } from "../../env.js";
import { webhookBodyLimitBytes } from "./body-limit.js";
import { evolutionWebhookBody, evolutionWebhookParams } from "./schema.js";

// Por-ROTA (só o webhook) — as demais rotas seguem no 1 MB default do Fastify (superfície menor
// no público). Derivado do maior vídeo aceito (`CREATIVE_MAX_WHATSAPP_VIDEO_MB`).
const WEBHOOK_BODY_LIMIT_BYTES = webhookBodyLimitBytes(env.CREATIVE_MAX_WHATSAPP_VIDEO_MB);

/**
 * Slice de webhooks (público, sem sessão). Valida o secret POR-INSTÂNCIA
 * (`channel_instances.webhook_secret`, §9/§12) no service; retorna 200 rápido
 * (o processamento roda no worker via fila).
 */
export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.webhooks;

  app.post("/webhooks/evolution/:instanceId", { bodyLimit: WEBHOOK_BODY_LIMIT_BYTES }, async (request, reply) => {
    const { instanceId } = evolutionWebhookParams.parse(request.params);
    const payload = evolutionWebhookBody.parse(request.body);
    const providedSecret = request.headers["x-webhook-secret"];

    // secret inválido → 401 no service (não vaza se a instância existe).
    const result = await service.handleEvolutionInbound(instanceId, providedSecret, payload);
    return reply.status(200).send(result);
  });
};
