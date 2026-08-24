import { eq } from "drizzle-orm";
import { channelGroups, type Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { MessagingChannelPort } from "@trafego/shared/ports";
import { badRequest } from "../../middleware/error-handler.js";
import { resolveConnectedInstance } from "../channels/service.js";
import type { ChannelGroupStateOutput, GroupsListOutput, SetGroupInput } from "./schema.js";

export interface GroupsDeps {
  readonly db: Database;
  readonly messaging: MessagingChannelPort;
}

/** Grupo ATIVO da org (1 linha por org — espelho de `channel_instances`). */
async function loadActiveGroupJid(db: Database, orgId: OrgId): Promise<string | null> {
  const [row] = await db
    .select({ groupJid: channelGroups.groupJid, status: channelGroups.status })
    .from(channelGroups)
    .where(eq(channelGroups.orgId, orgId))
    .limit(1);
  return row?.status === "active" ? row.groupJid : null;
}

/**
 * Slice de registro do grupo WhatsApp (G4) — o agente atua no grupo como espelho da
 * DM: a org escolhe UM grupo (dentre os que o número já integra) e liga. Proatividade
 * migra pro grupo quando ele está ativo (G2); o grupo varre TODAS as contas da org,
 * igual à DM (sem escopo por-grupo — fast-follow junto de N integrações).
 */
export function createGroupsService(deps: GroupsDeps) {
  return {
    /** Lista os grupos do número (Evolution) + qual está ativo pra org, se algum. */
    async list(orgId: OrgId): Promise<GroupsListOutput> {
      const activeGroupJid = await loadActiveGroupJid(deps.db, orgId);
      const instance = await resolveConnectedInstance(deps.db, orgId);
      if (!instance) return { channelConnected: false, groups: [], activeGroupJid };

      const groups = await deps.messaging.listGroups({ instanceId: instance.instanceId });
      return {
        channelConnected: true,
        groups: groups.map((g) => ({ jid: g.jid, name: g.name, ...(g.size != null ? { size: g.size } : {}) })),
        activeGroupJid,
      };
    },

    /** Define/atualiza o grupo ativo da org (upsert — 1 por org, como o número). */
    async set(orgId: OrgId, input: SetGroupInput): Promise<ChannelGroupStateOutput> {
      const instance = await resolveConnectedInstance(deps.db, orgId);
      if (!instance) throw badRequest("Conecte o WhatsApp antes de escolher um grupo.");

      const name = input.name ?? null;
      const [existing] = await deps.db.select({ id: channelGroups.id }).from(channelGroups).where(eq(channelGroups.orgId, orgId)).limit(1);
      if (existing) {
        await deps.db
          .update(channelGroups)
          .set({ evolutionInstance: instance.instanceId, groupJid: input.groupJid, name, status: "active" })
          .where(eq(channelGroups.id, existing.id));
      } else {
        await deps.db
          .insert(channelGroups)
          .values({ orgId, evolutionInstance: instance.instanceId, groupJid: input.groupJid, name, status: "active" });
      }
      return { active: true, groupJid: input.groupJid, name };
    },

    /** Desliga o grupo (soft — mantém o registro; reusável ao trocar de grupo depois). */
    async disable(orgId: OrgId): Promise<ChannelGroupStateOutput> {
      const [row] = await deps.db
        .update(channelGroups)
        .set({ status: "disabled" })
        .where(eq(channelGroups.orgId, orgId))
        .returning({ groupJid: channelGroups.groupJid, name: channelGroups.name });
      return { active: false, groupJid: row?.groupJid ?? null, name: row?.name ?? null };
    },
  };
}
