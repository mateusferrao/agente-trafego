import {
  MessagingChannelError,
  type ChannelInstanceRef,
  type InboundMessage,
  type InstanceState,
  type InstanceStatus,
  type MessagingChannelPort,
  type OutboundMessage,
} from "@trafego/shared/ports";
import { EvolutionApiError, EvolutionClient } from "./client.js";
import { EvolutionSender } from "./send.js";
import { parseInbound } from "./webhook.js";

export interface EvolutionAdapterDeps {
  readonly client: EvolutionClient;
  readonly sender?: EvolutionSender;
}

/** Integração Baileys (WhatsApp não-oficial) — parâmetro de criação da instância. */
const CREATE_INTEGRATION = "WHATSAPP-BAILEYS";
const HTTP_NOT_FOUND = 404;

/** Forma (parcial) das respostas da Evolution que consumimos. Vocabulário do provider fica aqui. */
interface EvolutionStateResponse {
  readonly instance?: { readonly state?: string };
}
interface EvolutionConnectResponse {
  readonly base64?: string; // QR em data-URL base64 (quando desconectado)
  readonly code?: string;
  readonly instance?: { readonly state?: string };
}

/** Mapeia o `state` da Evolution (`open|connecting|close`) → status neutro da porta. */
function mapState(state: string | undefined): InstanceStatus {
  if (state === "open") return "connected";
  if (state === "connecting") return "connecting";
  return "disconnected";
}

/**
 * Traduz qualquer falha ao falar com a Evolution (HTTP ou rede/`fetch failed`)
 * para o erro neutro da porta — a casca vira mensagem amigável sem conhecer o
 * provider. Preserva `MessagingChannelError` já tipado.
 */
function toChannelError(error: unknown): MessagingChannelError {
  if (error instanceof MessagingChannelError) return error;
  const detail = error instanceof EvolutionApiError ? `Evolution ${error.httpStatus}` : "sem conexão";
  return new MessagingChannelError("unavailable", `canal WhatsApp indisponível (${detail})`);
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
    try {
      return await this.sender.sendText(instance, msg);
    } catch (error) {
      throw toChannelError(error);
    }
  }

  parseInbound(payload: unknown): InboundMessage | null {
    // Normalização pura do payload cru do webhook (função sem IO).
    return parseInbound(payload);
  }

  /** Inicia a conexão: cria a instância se não existir, retorna o QR (ou conectado). */
  async connect(instance: ChannelInstanceRef): Promise<InstanceState> {
    try {
      const id = encodeURIComponent(instance.instanceId);
      await this.ensureInstance(instance.instanceId);
      const res = await this.client.request<EvolutionConnectResponse>({
        method: "GET",
        path: `instance/connect/${id}`,
      });
      // já pareado → conectado; senão, entrega o QR p/ o usuário escanear.
      if (res.instance?.state === "open") return { status: "connected" };
      return res.base64
        ? { status: "connecting", qrCode: res.base64 }
        : { status: mapState(res.instance?.state) };
    } catch (error) {
      throw toChannelError(error);
    }
  }

  async getState(instance: ChannelInstanceRef): Promise<InstanceState> {
    try {
      const res = await this.client.request<EvolutionStateResponse>({
        method: "GET",
        path: `instance/connectionState/${encodeURIComponent(instance.instanceId)}`,
      });
      return { status: mapState(res.instance?.state) };
    } catch (error) {
      throw toChannelError(error);
    }
  }

  /** Cria a instância na Evolution se ainda não existir (idempotente por nome). */
  private async ensureInstance(instanceId: string): Promise<void> {
    try {
      await this.client.request<EvolutionStateResponse>({
        method: "GET",
        path: `instance/connectionState/${encodeURIComponent(instanceId)}`,
      });
    } catch (error) {
      if (!(error instanceof EvolutionApiError) || error.httpStatus !== HTTP_NOT_FOUND) throw error;
      await this.client.request({
        method: "POST",
        path: "instance/create",
        body: { instanceName: instanceId, integration: CREATE_INTEGRATION, qrcode: true },
      });
    }
  }
}
