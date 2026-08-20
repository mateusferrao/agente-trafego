import type { InboundMessage } from "@trafego/shared/ports";

/**
 * Normalização do payload cru do webhook da Evolution → `InboundMessage`.
 *
 * NÃO valida secret aqui — a casca já validou o secret da instância antes de
 * chamar isto (§9). Retorna `null` quando o evento não é uma mensagem de texto
 * inbound processável (ex: status/ACK, fromMe=true, grupo, tipo não suportado).
 * Funções PURAS (sem IO) — testadas sem mock.
 */

/** Sufixo de JID de grupo (ignoramos grupos). */
const GROUP_SUFFIX = "@g.us";
/** Faixa de dígitos válida p/ DDI+telefone (defensivo contra JIDs estranhos). */
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15;
/** Evento de mensagem recebida, normalizado (aceita `MESSAGES_UPSERT` e `messages.upsert`). */
const UPSERT_EVENT = "messagesupsert";
/** Evento de mudança de conexão, normalizado. */
const CONNECTION_EVENT = "connectionupdate";

/** Status neutro do canal (espelha `InstanceStatus`). */
export type ConnectionStatus = "connected" | "connecting" | "disconnected";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Normaliza o nome do evento (case/pontuação variam entre configs da Evolution). */
function normalizeEvent(event: unknown): string {
  return typeof event === "string" ? event.toLowerCase().replace(/[^a-z]/g, "") : "";
}

/** Texto da mensagem: `conversation` (curta) ou `extendedTextMessage.text` (longa). */
function extractText(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const direct = message["conversation"];
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  const extended = asRecord(message["extendedTextMessage"]);
  const extText = extended?.["text"];
  if (typeof extText === "string" && extText.trim().length > 0) return extText.trim();
  return null;
}

/** Converte um JID do WhatsApp (55...@s.whatsapp.net) em telefone E.164. Grupo/inválido → null. */
export function jidToE164(jid: string): string | null {
  if (typeof jid !== "string" || jid.length === 0) return null;
  if (jid.endsWith(GROUP_SUFFIX)) return null;
  const digits = (jid.split("@")[0] ?? "").replace(/\D/g, "");
  return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS ? `+${digits}` : null;
}

/**
 * Extrai o status neutro de um evento CONNECTION_UPDATE (`open|connecting|close`),
 * ou null se não for esse evento / sem estado. Puro.
 */
export function parseConnectionUpdate(payload: unknown): ConnectionStatus | null {
  const root = asRecord(payload);
  if (!root) return null;
  if (normalizeEvent(root["event"]) !== CONNECTION_EVENT) return null;
  const data = asRecord(root["data"]);
  const state = data?.["state"];
  if (state === "open") return "connected";
  if (state === "connecting") return "connecting";
  if (typeof state === "string") return "disconnected";
  return null;
}

/** Extrai a mensagem inbound normalizada, ou null se deve ser ignorada. */
export function parseInbound(payload: unknown): InboundMessage | null {
  const root = asRecord(payload);
  if (!root) return null;
  if (normalizeEvent(root["event"]) !== UPSERT_EVENT) return null;

  const data = asRecord(root["data"]);
  const key = asRecord(data?.["key"]);
  if (!data || !key) return null;
  if (key["fromMe"] === true) return null; // nossa própria mensagem

  const from = jidToE164(typeof key["remoteJid"] === "string" ? (key["remoteJid"] as string) : "");
  if (!from) return null; // grupo / JID inválido

  const text = extractText(asRecord(data["message"]));
  if (!text) return null; // não-texto / vazio

  const messageId = key["id"];
  if (typeof messageId !== "string" || messageId.length === 0) return null;

  const instanceId = root["instance"];
  if (typeof instanceId !== "string" || instanceId.length === 0) return null;

  return { instanceId, from, text, messageId, raw: root };
}
