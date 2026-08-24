import type { InboundGroupContext, InboundMessage, MediaMessageKey } from "@trafego/shared/ports";

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
 * Monta o contexto NEUTRO de grupo: telefones mencionados (@) e autor da mensagem
 * citada (reply). O adapter NÃO decide se a mensagem "dirige" o bot — isso é IO na
 * casca (compara com o telefone da instância). `contextInfo` mora no
 * `extendedTextMessage` (marcações/reply vêm com texto estendido).
 */
function buildGroupContext(
  groupJid: string,
  senderPhone: string,
  message: Record<string, unknown> | null,
): InboundGroupContext {
  const extended = asRecord(message?.["extendedTextMessage"]);
  const ctx = asRecord(extended?.["contextInfo"]);
  const mentionedRaw = Array.isArray(ctx?.["mentionedJid"]) ? (ctx["mentionedJid"] as unknown[]) : [];
  const mentionedPhones = mentionedRaw
    .map((j) => (typeof j === "string" ? jidToE164(j) : null))
    .filter((p): p is string => p !== null);
  const quotedAuthorPhone = typeof ctx?.["participant"] === "string" ? jidToE164(ctx["participant"] as string) : null;
  return { groupJid, senderPhone, mentionedPhones, quotedAuthorPhone };
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

/** Mime default de nota de voz do WhatsApp (ogg/opus) quando o payload não traz. */
const DEFAULT_AUDIO_MIME = "audio/ogg";

/** Nós de mídia reconhecidos mas NÃO suportados (não-texto, não-áudio) → rótulo neutro. */
const UNSUPPORTED_MEDIA_NODES: ReadonlyArray<readonly [string, string]> = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
  ["contactMessage", "contact"],
  ["locationMessage", "location"],
];

/** Primeiro base64 não-vazio entre os candidatos (ou "" se nenhum). */
function firstBase64(...candidates: readonly unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

/**
 * Áudio (audioMessage/ptt) com bytes inline (webhook `base64:true`). O caminho
 * exato do base64 varia por versão da Evolution → procura em candidatos; ausente
 * → base64 vazio (o worker trata como falha amigável, nunca crash).
 */
function extractAudio(data: Record<string, unknown>): { base64: string; mimetype: string } | null {
  const message = asRecord(data["message"]);
  const audio = asRecord(message?.["audioMessage"]);
  if (!audio) return null;
  const rawMime = audio["mimetype"];
  const mimetype = typeof rawMime === "string" && rawMime.length > 0 ? rawMime : DEFAULT_AUDIO_MIME;
  const base64 = firstBase64(message?.["base64"], data["base64"], audio["base64"]);
  return { base64, mimetype };
}

/** Mídia reconhecida mas não-suportada → rótulo neutro (ou null se não for). */
function detectMediaType(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  for (const [node, label] of UNSUPPORTED_MEDIA_NODES) {
    if (asRecord(message[node])) return label;
  }
  return null;
}

/** Extrai a mensagem inbound normalizada (união por `kind`), ou null se ignorar. */
export function parseInbound(payload: unknown): InboundMessage | null {
  const root = asRecord(payload);
  if (!root) return null;
  if (normalizeEvent(root["event"]) !== UPSERT_EVENT) return null;

  const data = asRecord(root["data"]);
  const key = asRecord(data?.["key"]);
  if (!data || !key) return null;
  if (key["fromMe"] === true) return null; // nossa própria mensagem

  const remoteJid = typeof key["remoteJid"] === "string" ? (key["remoteJid"] as string) : "";
  const message = asRecord(data["message"]);

  // Grupo (@g.us): o remetente é o `participant`, não o `remoteJid` (que é o grupo).
  // Sem participant identificável não dá pra rotear → ignora.
  let from: string | null;
  let group: InboundGroupContext | undefined;
  if (remoteJid.endsWith(GROUP_SUFFIX)) {
    const senderPhone = jidToE164(typeof key["participant"] === "string" ? (key["participant"] as string) : "");
    if (!senderPhone) return null;
    from = senderPhone;
    group = buildGroupContext(remoteJid, senderPhone, message);
  } else {
    from = jidToE164(remoteJid);
    if (!from) return null; // JID inválido
  }

  const messageId = key["id"];
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  const instanceId = root["instance"];
  if (typeof instanceId !== "string" || instanceId.length === 0) return null;

  const base = { instanceId, from, messageId, raw: root, ...(group ? { group } : {}) } as const;

  const text = extractText(message);
  if (text) return { ...base, kind: "text", text };

  const audio = extractAudio(data);
  if (audio) {
    const messageKey: MediaMessageKey = { id: messageId, remoteJid: key["remoteJid"] as string, fromMe: false };
    return { ...base, kind: "audio", audio, messageKey };
  }

  const mediaType = detectMediaType(message);
  if (mediaType) return { ...base, kind: "unsupported", mediaType };

  return null; // sem conteúdo reconhecível (ACK/status/etc) → silêncio
}
