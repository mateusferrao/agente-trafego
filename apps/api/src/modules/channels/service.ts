import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { channelInstances, type Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { ChannelInstanceRef, InstanceState, MessagingChannelPort } from "@trafego/shared/ports";

export interface ChannelsDeps {
  readonly db: Database;
  readonly messaging: MessagingChannelPort;
}

const WEBHOOK_SECRET_BYTES = 24;

/** Nome estável e único da instância Evolution por org (1 número por org — §9). */
function instanceName(orgId: OrgId): string {
  return `org-${orgId}`;
}

/**
 * Slice de canal WhatsApp (Evolution — 1 instância por org). Garante a linha
 * `channel_instances` da org, conecta via QR e expõe o estado. Ban-safety/opt-in
 * (verificação de contato) vive no slice `contacts`.
 */
export function createChannelsService(deps: ChannelsDeps) {
  /** Garante a linha `channel_instances` da org (idempotente por org). Devolve o
   *  secret por-instância p/ o registro do webhook (validado pela casca no inbound). */
  async function ensureInstance(orgId: OrgId): Promise<{ evolutionInstance: string; webhookSecret: string }> {
    const [existing] = await deps.db
      .select({
        evolutionInstance: channelInstances.evolutionInstance,
        webhookSecret: channelInstances.webhookSecret,
      })
      .from(channelInstances)
      .where(eq(channelInstances.orgId, orgId))
      .limit(1);
    if (existing) return existing;

    const secret = randomBytes(WEBHOOK_SECRET_BYTES).toString("base64url");
    const [row] = await deps.db
      .insert(channelInstances)
      .values({ orgId, evolutionInstance: instanceName(orgId), webhookSecret: secret })
      .returning({
        evolutionInstance: channelInstances.evolutionInstance,
        webhookSecret: channelInstances.webhookSecret,
      });
    return row ?? { evolutionInstance: instanceName(orgId), webhookSecret: secret };
  }

  /** Persiste o estado observado (status/phone) na linha da org. */
  async function persistState(orgId: OrgId, state: InstanceState): Promise<void> {
    await deps.db
      .update(channelInstances)
      .set({
        status: state.status,
        ...(state.phone ? { phone: state.phone } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(channelInstances.orgId, orgId));
  }

  return {
    /** Cria/conecta a instância Evolution da org e devolve o QR p/ parear. */
    async connect(orgId: OrgId): Promise<InstanceState> {
      const { evolutionInstance, webhookSecret } = await ensureInstance(orgId);
      // secret por-instância vai no ref → o adapter registra o webhook no connect.
      const ref: ChannelInstanceRef = { instanceId: evolutionInstance, webhookSecret };
      const state = await deps.messaging.connect(ref);
      await persistState(orgId, state);
      return state;
    },

    /**
     * Estado atual do canal da org (sem QR). Padrão = estado **persistido** no DB
     * (rápido, sem round-trip à Evolution) — mantido fresco pelo webhook
     * `CONNECTION_UPDATE` e pelos próprios connect/disconnect. Se o webhook se perder
     * (Evolution fora, secret rotacionado), o DB pode ficar stale; `?live=true` (usado
     * pelo fluxo de QR / "Gerenciar") é a fonte da verdade e reconcilia. É display-only:
     * o envio real resolve a instância na hora e falha explícito se o canal caiu. `live`
     * força o probe ao vivo (`getState`), necessário no fluxo de QR (detecta o pareamento
     * em tempo real).
     */
    async status(orgId: OrgId, opts?: { readonly live?: boolean }): Promise<InstanceState> {
      const [row] = await deps.db
        .select({
          evolutionInstance: channelInstances.evolutionInstance,
          status: channelInstances.status,
          phone: channelInstances.phone,
        })
        .from(channelInstances)
        .where(eq(channelInstances.orgId, orgId))
        .limit(1);
      if (!row) return { status: "disconnected" };
      if (!opts?.live) {
        return { status: row.status, ...(row.phone ? { phone: row.phone } : {}) };
      }
      const state = await deps.messaging.getState({ instanceId: row.evolutionInstance });
      await persistState(orgId, state);
      return state;
    },

    /** Desfaz o pareamento do número da org (logout). Instância fica p/ re-parear. */
    async disconnect(orgId: OrgId): Promise<InstanceState> {
      const [row] = await deps.db
        .select({ evolutionInstance: channelInstances.evolutionInstance })
        .from(channelInstances)
        .where(eq(channelInstances.orgId, orgId))
        .limit(1);
      if (!row) return { status: "disconnected" };
      await deps.messaging.disconnect({ instanceId: row.evolutionInstance });
      const state: InstanceState = { status: "disconnected" };
      await persistState(orgId, state);
      return state;
    },
  };
}

/** Resolve a instância conectada da org (helper reusável p/ contacts/notify). */
export async function resolveConnectedInstance(
  db: Database,
  orgId: OrgId,
): Promise<{ instanceId: string } | null> {
  const [row] = await db
    .select({ evolutionInstance: channelInstances.evolutionInstance, status: channelInstances.status })
    .from(channelInstances)
    .where(and(eq(channelInstances.orgId, orgId), eq(channelInstances.status, "connected")))
    .limit(1);
  return row ? { instanceId: row.evolutionInstance } : null;
}
