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
  /** Garante a linha `channel_instances` da org (idempotente por org). */
  async function ensureInstance(orgId: OrgId): Promise<{ evolutionInstance: string }> {
    const [existing] = await deps.db
      .select({ evolutionInstance: channelInstances.evolutionInstance })
      .from(channelInstances)
      .where(eq(channelInstances.orgId, orgId))
      .limit(1);
    if (existing) return existing;

    const [row] = await deps.db
      .insert(channelInstances)
      .values({
        orgId,
        evolutionInstance: instanceName(orgId),
        webhookSecret: randomBytes(WEBHOOK_SECRET_BYTES).toString("base64url"),
      })
      .returning({ evolutionInstance: channelInstances.evolutionInstance });
    return row ?? { evolutionInstance: instanceName(orgId) };
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
      const { evolutionInstance } = await ensureInstance(orgId);
      const ref: ChannelInstanceRef = { instanceId: evolutionInstance };
      const state = await deps.messaging.connect(ref);
      await persistState(orgId, state);
      return state;
    },

    /** Estado atual do canal da org (sem QR). */
    async status(orgId: OrgId): Promise<InstanceState> {
      const [row] = await deps.db
        .select({ evolutionInstance: channelInstances.evolutionInstance })
        .from(channelInstances)
        .where(eq(channelInstances.orgId, orgId))
        .limit(1);
      if (!row) return { status: "disconnected" };
      const state = await deps.messaging.getState({ instanceId: row.evolutionInstance });
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
