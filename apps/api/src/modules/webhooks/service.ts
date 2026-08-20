import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { channelInstances, type Database } from "@trafego/db";
import {
  WHATSAPP_INBOUND_JOB,
  WHATSAPP_INBOUND_QUEUE,
  type WhatsappInboundPayload,
} from "@trafego/shared";
import type { SchedulerPort } from "@trafego/shared/ports";
import { unauthorized } from "../../middleware/error-handler.js";

export interface WebhooksDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
}

export interface InboundResult {
  readonly accepted: boolean;
}

/** Comparação em tempo constante (evita timing attack no secret). */
function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Slice de webhooks. Recebe inbound da Evolution: valida o secret **da instância**
 * (§9/§12 — por-org, rotacionável) e enfileira o payload CRU no worker. Casca fina,
 * zero lógica de agente/parse aqui (o worker normaliza via `parseInbound`).
 */
export function createWebhooksService(deps: WebhooksDeps) {
  return {
    /** Valida o secret da instância e enfileira o payload cru. Secret inválido → 401. */
    async handleEvolutionInbound(
      instanceId: string,
      providedSecret: unknown,
      payload: Readonly<Record<string, unknown>>,
    ): Promise<InboundResult> {
      const [instance] = await deps.db
        .select({ webhookSecret: channelInstances.webhookSecret })
        .from(channelInstances)
        .where(eq(channelInstances.evolutionInstance, instanceId))
        .limit(1);

      // instância desconhecida ou secret ausente/divergente → não autorizado (não vaza estado).
      if (
        !instance ||
        typeof providedSecret !== "string" ||
        !secretsMatch(providedSecret, instance.webhookSecret)
      ) {
        throw unauthorized("Assinatura de webhook inválida");
      }

      const jobPayload: WhatsappInboundPayload = { instanceId, raw: payload };
      await deps.scheduler.enqueue({
        queue: WHATSAPP_INBOUND_QUEUE,
        name: WHATSAPP_INBOUND_JOB,
        payload: jobPayload,
      });
      return { accepted: true };
    },
  };
}
