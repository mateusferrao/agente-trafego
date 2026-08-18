export interface ChannelInstanceRef {
  readonly instanceId: string;
}

export interface OutboundMessage {
  readonly to: string; // telefone E.164
  readonly text: string;
}

export interface InboundMessage {
  readonly instanceId: string;
  readonly from: string; // telefone E.164
  readonly text: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type InstanceStatus = "disconnected" | "connecting" | "connected";

export interface InstanceState {
  readonly status: InstanceStatus;
  readonly qrCode?: string; // base64 quando connecting
  readonly phone?: string;
}

/**
 * Borda de canal de mensageria. Adapter MVP = Evolution (não-oficial).
 * Trocar por WhatsApp Cloud API / pool de números = novo adapter.
 * Ban-safety (throttle/opt-in/ignorar desconhecido) é responsabilidade da casca,
 * não do adapter.
 */
export interface MessagingChannelPort {
  sendMessage(instance: ChannelInstanceRef, msg: OutboundMessage): Promise<void>;
  /** Normaliza o payload cru do webhook em InboundMessage (ou null se ignorar). */
  parseInbound(payload: unknown): InboundMessage | null;
  connect(instance: ChannelInstanceRef): Promise<InstanceState>;
  getState(instance: ChannelInstanceRef): Promise<InstanceState>;
}
