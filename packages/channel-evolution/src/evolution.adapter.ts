import type {
  ChannelInstanceRef,
  InboundMessage,
  InstanceState,
  MessagingChannelPort,
  OutboundMessage,
} from "@trafego/shared/ports";
import { EvolutionClient } from "./client.js";
import { EvolutionSender } from "./send.js";
import { parseInbound } from "./webhook.js";

export interface EvolutionAdapterDeps {
  readonly client: EvolutionClient;
  readonly sender?: EvolutionSender;
}

/**
 * Adapter Evolution (não-oficial) da `MessagingChannelPort`.
 * Trocar por WhatsApp Cloud API / pool de números = novo adapter, sem tocar no core.
 */
export class EvolutionAdapter implements MessagingChannelPort {
  private readonly client: EvolutionClient;
  private readonly sender: EvolutionSender;

  constructor(deps: EvolutionAdapterDeps) {
    this.client = deps.client;
    this.sender = deps.sender ?? new EvolutionSender(deps.client);
  }

  async sendMessage(instance: ChannelInstanceRef, msg: OutboundMessage): Promise<void> {
    // TODO: delega ao sender (message/sendText).
    return this.sender.sendText(instance, msg);
  }

  parseInbound(payload: unknown): InboundMessage | null {
    // Normalização pura do payload cru do webhook (função sem IO).
    return parseInbound(payload);
  }

  async connect(instance: ChannelInstanceRef): Promise<InstanceState> {
    // TODO: GET instance/connect/{instanceId} → { qrCode(base64), status }.
    throw new Error("not implemented");
  }

  async getState(instance: ChannelInstanceRef): Promise<InstanceState> {
    // TODO: GET instance/connectionState/{instanceId} → mapear p/ InstanceStatus.
    throw new Error("not implemented");
  }
}
