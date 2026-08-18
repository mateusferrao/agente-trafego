import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { InstanceState, MessagingChannelPort } from "@trafego/shared/ports";
import type { VerifyContactInput } from "./schema.js";

export interface ChannelsDeps {
  readonly db: Database;
  readonly messaging: MessagingChannelPort;
}

/**
 * Slice de canal WhatsApp (Evolution — 1 instância por org). Conecta via QR,
 * expõe status, e verifica contatos (opt-in de ban-safety §8/§9).
 */
export function createChannelsService(deps: ChannelsDeps) {
  return {
    /** Cria/conecta a instância Evolution da org e devolve o QR p/ parear. */
    async connect(_orgId: OrgId): Promise<InstanceState> {
      // TODO: resolver channel_instances da org (ou criar) → messaging.connect(ref).
      return deps.messaging.connect({ instanceId: "TODO" });
    },

    async status(_orgId: OrgId): Promise<InstanceState> {
      // TODO: resolver instanceId da org → messaging.getState(ref).
      return deps.messaging.getState({ instanceId: "TODO" });
    },

    /** Registra/verifica um contato WhatsApp vinculado a um user da org. */
    async verifyContact(_orgId: OrgId, _input: VerifyContactInput): Promise<{ verified: boolean }> {
      // TODO: upsert contacts(phone, user_id, role, verified=false) + fluxo de verificação (código/1ª msg).
      void deps.db;
      return { verified: false };
    },
  };
}
