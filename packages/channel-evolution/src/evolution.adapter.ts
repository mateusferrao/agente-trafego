import {
  MessagingChannelError,
  type ChannelInstanceRef,
  type InboundMessage,
  type InstanceState,
  type InstanceStatus,
  type MediaMessageKey,
  type MessagingChannelPort,
  type OutboundMessage,
} from "@trafego/shared/ports";
import { EvolutionApiError, EvolutionClient } from "./client.js";
import { EvolutionSender } from "./send.js";
import { parseConnectionUpdate, parseInbound } from "./webhook.js";

export interface EvolutionAdapterDeps {
  readonly client: EvolutionClient;
  readonly sender?: EvolutionSender;
  /** Origin público da API p/ montar a URL do webhook (ex: https://api.exemplo.com).
   *  Ausente → `connect` não registra webhook (útil no worker, que só envia). */
  readonly apiOrigin?: string;
}

/** Integração Baileys (WhatsApp não-oficial) — parâmetro de criação da instância. */
const CREATE_INTEGRATION = "WHATSAPP-BAILEYS";
const HTTP_NOT_FOUND = 404;
/** Eventos que assinamos no webhook (vocabulário Evolution vive no adapter — §7). */
const WEBHOOK_EVENTS = ["MESSAGES_UPSERT", "CONNECTION_UPDATE"];
/** Header por-instância validado pela casca no inbound (§9). */
const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

/** Forma (parcial) das respostas da Evolution que consumimos. Vocabulário do provider fica aqui. */
interface EvolutionStateResponse {
  readonly instance?: { readonly state?: string };
}
interface EvolutionConnectResponse {
  readonly base64?: string; // QR em data-URL base64 (quando desconectado)
  readonly code?: string;
  readonly instance?: { readonly state?: string };
}
interface EvolutionMediaResponse {
  readonly base64?: string;
}

/** Mapeia o `state` da Evolution (`open|connecting|close`) → status neutro da porta. */
function mapState(state: string | undefined): InstanceStatus {
  if (state === "open") return "connected";
  if (state === "connecting") return "connecting";
  return "disconnected";
}

/**
 * Extrai o número dono da instância do payload do `fetchInstances` (varia entre
 * versões da Evolution) — defensivo: tenta `ownerJid`/`owner` no objeto ou em
 * `instance{}`, tira o sufixo `@s.whatsapp.net`, valida DDI+dígitos. Falha → undefined.
 */
function extractOwnerPhone(res: unknown): string | undefined {
  const first = Array.isArray(res) ? res[0] : res;
  if (typeof first !== "object" || first === null) return undefined;
  const record = first as Record<string, unknown>;
  const nested = typeof record["instance"] === "object" ? (record["instance"] as Record<string, unknown>) : {};
  const raw = record["ownerJid"] ?? record["owner"] ?? nested["ownerJid"] ?? nested["owner"];
  if (typeof raw !== "string") return undefined;
  const digits = raw.split("@")[0]?.replace(/\D/g, "") ?? "";
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
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
  private readonly apiOrigin: string | undefined;

  constructor(deps: EvolutionAdapterDeps) {
    this.client = deps.client;
    this.sender = deps.sender ?? new EvolutionSender(deps.client);
    this.apiOrigin = deps.apiOrigin;
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

  parseConnectionUpdate(payload: unknown): InstanceStatus | null {
    return parseConnectionUpdate(payload);
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
      // registra o webhook (idempotente, best-effort — pareamento não pode falhar por isso).
      await this.syncWebhook(instance);
      // já pareado → conectado (com o número pareado); senão, entrega o QR.
      if (res.instance?.state === "open") return this.connectedState(instance.instanceId);
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
      const status = mapState(res.instance?.state);
      return status === "connected" ? this.connectedState(instance.instanceId) : { status };
    } catch (error) {
      throw toChannelError(error);
    }
  }

  /** Estado conectado enriquecido com o número pareado (best-effort — não bloqueia). */
  private async connectedState(instanceId: string): Promise<InstanceState> {
    const phone = await this.fetchOwnerPhone(instanceId);
    return phone ? { status: "connected", phone } : { status: "connected" };
  }

  /** Número dono da instância (quem parear no QR), via fetchInstances. Falha → undefined. */
  private async fetchOwnerPhone(instanceId: string): Promise<string | undefined> {
    try {
      const res = await this.client.request<unknown>({
        method: "GET",
        path: `instance/fetchInstances?instanceName=${encodeURIComponent(instanceId)}`,
      });
      return extractOwnerPhone(res);
    } catch {
      return undefined; // enriquecimento é opcional; não derruba o status
    }
  }

  /** Logout do número (mantém a instância p/ re-parear). 404 = já desconectado (no-op). */
  async disconnect(instance: ChannelInstanceRef): Promise<void> {
    try {
      await this.client.request({
        method: "DELETE",
        path: `instance/logout/${encodeURIComponent(instance.instanceId)}`,
      });
    } catch (error) {
      if (error instanceof EvolutionApiError && error.httpStatus === HTTP_NOT_FOUND) return;
      throw toChannelError(error);
    }
  }

  /**
   * Registra/re-registra o webhook da instância (idempotente — sobrescreve a
   * config). Chamado no `connect` e reusável direto p/ backfill one-time
   * (instâncias já pareadas antes de uma mudança na config do webhook). Best-effort:
   * quem chama não pode falhar por causa disto; sem `apiOrigin`/secret, não registra.
   */
  async syncWebhook(instance: ChannelInstanceRef): Promise<void> {
    if (!this.apiOrigin || !instance.webhookSecret) return;
    const url = `${this.apiOrigin}/webhooks/evolution/${encodeURIComponent(instance.instanceId)}`;
    try {
      await this.client.request({
        method: "POST",
        path: `webhook/set/${encodeURIComponent(instance.instanceId)}`,
        body: {
          webhook: {
            enabled: true,
            url,
            byEvents: false,
            // entrega a mídia decriptada inline (base64) no próprio webhook — o worker
            // transcreve nota de voz na borda sem re-fetch (evita o getBase64, bugado).
            base64: true,
            headers: { [WEBHOOK_SECRET_HEADER]: instance.webhookSecret },
            events: WEBHOOK_EVENTS,
          },
        },
      });
    } catch {
      // registro falhou → inbound não chega até re-conectar; não derruba o pareamento.
    }
  }

  /**
   * Busca o base64 decriptado de uma mídia direto na Evolution (`chat/getBase64FromMediaMessage`)
   * — fallback pro caso do webhook não entregar inline (observado em áudio/`ptt` mesmo
   * com `base64:true` registrado). Best-effort: qualquer falha (HTTP/rede/shape
   * inesperado) vira `null`, nunca lança — quem chama decide o que fazer sem mídia.
   */
  async fetchMediaBase64(instance: ChannelInstanceRef, key: MediaMessageKey): Promise<string | null> {
    try {
      const res = await this.client.request<EvolutionMediaResponse>({
        method: "POST",
        path: `chat/getBase64FromMediaMessage/${encodeURIComponent(instance.instanceId)}`,
        body: { message: { key: { id: key.id, remoteJid: key.remoteJid, fromMe: key.fromMe } } },
      });
      return typeof res.base64 === "string" && res.base64.length > 0 ? res.base64 : null;
    } catch {
      return null;
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
