import type { InboundGroupContext, InboundMessage, MediaMessageKey } from "@trafego/shared/ports";

/**
 * Normalização do payload cru do webhook da Evolution → `InboundMessage`.
 *
 * NÃO valida secret aqui — a casca já validou o secret da instância antes de
 * chamar isto (§9). Retorna `null` quando o evento não é uma mensagem de texto
 * inbound processável (ex: status/ACK, fromMe=true, grupo, tipo não suportado).
 * Funções PURAS (sem IO) — testadas sem mock.
 */

/** Sufixo de JID de grupo (@g.us). */
const GROUP_SUFFIX = "@g.us";
/** Sufixo de JID por-id-interno (LID) — grupos migrados (`addressingMode: "lid"` no
 *  payload) endereçam participantes por um id opaco, não pelo telefone. LID não é
 *  reversível pra telefone (não é derivado dele) — nunca tratar como E.164. */
const LID_SUFFIX = "@lid";
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

/** Converte um JID do WhatsApp (55...@s.whatsapp.net) em telefone E.164. Grupo/LID/inválido → null. */
export function jidToE164(jid: string): string | null {
  if (typeof jid !== "string" || jid.length === 0) return null;
  if (jid.endsWith(GROUP_SUFFIX) || jid.endsWith(LID_SUFFIX)) return null;
  const digits = (jid.split("@")[0] ?? "").replace(/\D/g, "");
  return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS ? `+${digits}` : null;
}

/**
 * Nós de mensagem que podem carregar `contextInfo` (@menção/reply): texto vira
 * `extendedTextMessage` quando tem contexto; mídia (áudio incl. — WhatsApp não permite
 * @menção em áudio, então reply é o ÚNICO jeito de dirigir o bot por nota de voz) carrega
 * o `contextInfo` DIRETO no próprio nó de tipo, não em `extendedTextMessage`.
 */
const CONTEXT_INFO_NODES = [
  "extendedTextMessage",
  "audioMessage",
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "stickerMessage",
] as const;

/**
 * `contextInfo` (menção @ / reply) vem como IRMÃO de `message` dentro de `data` na
 * Evolution — não aninhado em `message.extendedTextMessage.contextInfo` como no
 * Baileys puro (observado em produção). Checa esse local primeiro; mantém o
 * fallback aninhado por robustez a outras versões/formas do payload.
 */
function findContextInfo(
  data: Record<string, unknown>,
  message: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const direct = asRecord(data["contextInfo"]);
  if (direct) return direct;
  if (!message) return null;
  for (const node of CONTEXT_INFO_NODES) {
    const ctx = asRecord(asRecord(message[node])?.["contextInfo"]);
    if (ctx) return ctx;
  }
  return null;
}

/**
 * Monta o contexto NEUTRO de grupo: telefones mencionados (@) e autor da mensagem
 * citada (reply). O adapter NÃO decide se a mensagem "dirige" o bot — isso é IO na
 * casca (compara com o telefone da instância). Menção/reply por LID sem telefone
 * direto (terceiro, não o remetente) preserva o LID cru em `mentionedLids`/
 * `quotedAuthorLid` — a casca resolve via `resolveGroupParticipants` (fallback).
 */
function buildGroupContext(
  groupJid: string,
  senderPhone: string,
  data: Record<string, unknown>,
  message: Record<string, unknown> | null,
): InboundGroupContext {
  const ctx = findContextInfo(data, message);
  const mentionedRaw = (Array.isArray(ctx?.["mentionedJid"]) ? (ctx["mentionedJid"] as unknown[]) : []).filter(
    (j): j is string => typeof j === "string",
  );
  const mentionedPhones = mentionedRaw.map((j) => jidToE164(j)).filter((p): p is string => p !== null);
  const mentionedLids = mentionedRaw.filter((j) => j.endsWith(LID_SUFFIX));

  const quotedRaw = typeof ctx?.["participant"] === "string" ? (ctx["participant"] as string) : null;
  const quotedAuthorPhone = quotedRaw ? jidToE164(quotedRaw) : null;
  const quotedAuthorLid = quotedRaw && quotedRaw.endsWith(LID_SUFFIX) ? quotedRaw : null;

  // nome de exibição do remetente (pushName) — atribuição legível no contexto ambiente.
  const rawName = data["pushName"];
  const senderName = typeof rawName === "string" && rawName.length > 0 ? rawName : null;

  const { quotedStanzaId, quotedKind, quotedSnippet } = extractQuoted(ctx);

  return {
    groupJid,
    senderPhone,
    senderName,
    mentionedPhones,
    quotedAuthorPhone,
    mentionedLids,
    quotedAuthorLid,
    quotedStanzaId,
    quotedKind,
    quotedSnippet,
  };
}

/** Teto do trecho da mensagem citada (reply) no contexto do agente — generoso p/ não perder o
 *  referente (a mensagem à qual o usuário está respondendo); os orçamentos de token do transcript
 *  de grupo e da janela de entrada já limitam o contexto como um todo. Só um trilho de sanidade. */
const QUOTED_SNIPPET_MAX = 4000;

/**
 * Extrai a mensagem CITADA (reply) do `contextInfo`: id (`stanzaId`), tipo e trecho.
 * Texto → snippet truncado; mídia → `kind` + snippet null (o áudio citado é transcrito
 * na casca via `fetchMediaBase64` usando o `stanzaId`). Sem citação → tudo null.
 */
function extractQuoted(ctx: Record<string, unknown> | null): {
  quotedStanzaId: string | null;
  quotedKind: InboundGroupContext["quotedKind"];
  quotedSnippet: string | null;
} {
  const quoted = asRecord(ctx?.["quotedMessage"]);
  if (!quoted) return { quotedStanzaId: null, quotedKind: null, quotedSnippet: null };
  const stanzaId = typeof ctx?.["stanzaId"] === "string" ? (ctx["stanzaId"] as string) : null;

  const trunc = (s: string): string => (s.length > QUOTED_SNIPPET_MAX ? `${s.slice(0, QUOTED_SNIPPET_MAX)}…` : s);
  const conversation = typeof quoted["conversation"] === "string" ? (quoted["conversation"] as string) : null;
  const extText = asRecord(quoted["extendedTextMessage"]);
  const extTextValue = typeof extText?.["text"] === "string" ? (extText["text"] as string) : null;
  const text = conversation ?? extTextValue;
  if (text !== null) return { quotedStanzaId: stanzaId, quotedKind: "text", quotedSnippet: trunc(text) };
  if (asRecord(quoted["audioMessage"])) return { quotedStanzaId: stanzaId, quotedKind: "audio", quotedSnippet: null };
  if (asRecord(quoted["imageMessage"])) return { quotedStanzaId: stanzaId, quotedKind: "image", quotedSnippet: null };
  return { quotedStanzaId: stanzaId, quotedKind: "media", quotedSnippet: null };
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

/** Nós de mídia reconhecidos mas NÃO suportados (não-texto/áudio/imagem/vídeo) → rótulo neutro. */
const UNSUPPORTED_MEDIA_NODES: ReadonlyArray<readonly [string, string]> = [
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
  ["contactMessage", "contact"],
  ["locationMessage", "location"],
];

/** Mime default de imagem quando o payload não traz o mimetype. */
const DEFAULT_IMAGE_MIME = "image/jpeg";
/** Mime default de vídeo quando o payload não traz o mimetype. */
const DEFAULT_VIDEO_MIME = "video/mp4";

/**
 * Nós que ENVELOPAM a mensagem real: ver-uma-vez (foto/vídeo), mensagem temporária,
 * documento-com-legenda e mensagem editada entregam o conteúdo aninhado em `.message`.
 * Sem desembrulhar, `message.videoMessage` some e o vídeo cai em `null` → silêncio
 * (bug confirmado em prod). Recursivo com cap de profundidade (anti-loop em payload patológico).
 */
const WRAPPER_NODES = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
] as const;
const UNWRAP_MAX_DEPTH = 6;

function unwrapMessage(message: Record<string, unknown> | null, depth = 0): Record<string, unknown> | null {
  if (!message || depth >= UNWRAP_MAX_DEPTH) return message;
  for (const node of WRAPPER_NODES) {
    const inner = asRecord(asRecord(message[node])?.["message"]);
    if (inner) return unwrapMessage(inner, depth + 1);
  }
  return message;
}

/** Prefixos de mimetype que promovem um `documentMessage` a mídia de 1ª classe. */
const DOC_MEDIA_PREFIX = { video: "video/", image: "image/" } as const;

/**
 * `documentMessage` com mimetype de vídeo/imagem = mídia mandada "como documento" por alguns
 * clientes — hoje viraria `unsupported` (aviso) e nunca entraria na biblioteca. Promove a
 * vídeo/imagem; outros documentos (pdf/zip) seguem `unsupported`. Retorna o discriminante ou null.
 */
function extractDocumentMedia(
  message: Record<string, unknown> | null,
  data: Record<string, unknown>,
):
  | { kind: "video"; mimetype: string; caption: string | null; fileLength?: number }
  | { kind: "image"; base64: string; mimetype: string; caption: string | null }
  | null {
  const doc = asRecord(message?.["documentMessage"]);
  const mime = typeof doc?.["mimetype"] === "string" ? (doc["mimetype"] as string) : "";
  if (!doc || mime.length === 0) return null;
  if (mime.startsWith(DOC_MEDIA_PREFIX.video)) {
    const fileLength = parseFileLength(doc["fileLength"]);
    return { kind: "video", mimetype: mime, caption: captionOf(doc), ...(fileLength !== undefined ? { fileLength } : {}) };
  }
  if (mime.startsWith(DOC_MEDIA_PREFIX.image)) {
    const base64 = firstBase64(message?.["base64"], data["base64"], doc["base64"]);
    return { kind: "image", base64, mimetype: mime, caption: captionOf(doc) };
  }
  return null;
}

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
function extractAudio(
  message: Record<string, unknown> | null,
  data: Record<string, unknown>,
): { base64: string; mimetype: string } | null {
  const audio = asRecord(message?.["audioMessage"]);
  if (!audio) return null;
  const rawMime = audio["mimetype"];
  const mimetype = typeof rawMime === "string" && rawMime.length > 0 ? rawMime : DEFAULT_AUDIO_MIME;
  const base64 = firstBase64(message?.["base64"], data["base64"], audio["base64"]);
  return { base64, mimetype };
}

/**
 * Imagem (imageMessage) com bytes inline (webhook `base64:true`). Mesmo quirk do
 * áudio: o caminho do base64 varia por versão → procura em candidatos; ausente →
 * base64 vazio (o worker de intake busca por `fetchMediaBase64`, nunca crash).
 */
function extractImage(
  message: Record<string, unknown> | null,
  data: Record<string, unknown>,
): { base64: string; mimetype: string; caption: string | null } | null {
  const image = asRecord(message?.["imageMessage"]);
  if (!image) return null;
  const rawMime = image["mimetype"];
  const mimetype = typeof rawMime === "string" && rawMime.length > 0 ? rawMime : DEFAULT_IMAGE_MIME;
  const base64 = firstBase64(message?.["base64"], data["base64"], image["base64"]);
  return { base64, mimetype, caption: captionOf(image) };
}

/** Legenda de um nó de mídia (`caption`), normalizada — vazia/ausente → null. */
function captionOf(node: Record<string, unknown>): string | null {
  const raw = node["caption"];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Vídeo (videoMessage) — F7 intake. NÃO extrai base64 (vídeo é grande demais p/ o payload da
 * fila): só detecta o nó + mimetype + legenda + `fileLength`; o worker de intake busca os bytes
 * por `messageKey`. `fileLength` (P0.3) é o TAMANHO do arquivo que o WhatsApp já entrega na
 * metadata — dá pro intake recusar vídeo grande demais ANTES de baixar/decodificar os bytes
 * (HTTP HEAD é inviável: a Evolution só entrega mídia por base64, nunca por URL).
 */
function extractVideo(
  message: Record<string, unknown> | null,
): { mimetype: string; caption: string | null; fileLength?: number } | null {
  // `ptvMessage` = nota de vídeo redonda (nó SEPARADO de `videoMessage` no Baileys/Evolution).
  const video = asRecord(message?.["videoMessage"]) ?? asRecord(message?.["ptvMessage"]);
  if (!video) return null;
  const rawMime = video["mimetype"];
  const mimetype = typeof rawMime === "string" && rawMime.length > 0 ? rawMime : DEFAULT_VIDEO_MIME;
  const fileLength = parseFileLength(video["fileLength"]);
  return { mimetype, caption: captionOf(video), ...(fileLength !== undefined ? { fileLength } : {}) };
}

/** `fileLength` chega como string decimal (protobuf int64) na maioria das versões da Evolution;
 *  aceita number também (defensivo). Não-numérico/ausente → `undefined` (o intake cai no fallback
 *  pós-decode, nunca crasha por metadata estranha). */
function parseFileLength(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Mídia reconhecida mas não-suportada → rótulo neutro (ou null se não for). */
function detectMediaType(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  for (const [node, label] of UNSUPPORTED_MEDIA_NODES) {
    if (asRecord(message[node])) return label;
  }
  return null;
}

/**
 * Diagnóstico (observabilidade) de um payload que `parseInbound` ignorou: os NOMES das chaves
 * de `data.message` (+ `messageType`) — sem conteúdo. Deixa visível no log um tipo de mídia novo
 * (ex: `ptvMessage`, wrapper) antes de virar silêncio. Vocabulário da Evolution fica só aqui.
 */
export function inboundMessageShape(payload: unknown): { messageKeys: string[]; messageType?: string } | null {
  const data = asRecord(asRecord(payload)?.["data"]);
  if (!data) return null;
  const message = asRecord(data["message"]);
  const messageType = typeof data["messageType"] === "string" ? (data["messageType"] as string) : undefined;
  return { messageKeys: message ? Object.keys(message) : [], ...(messageType ? { messageType } : {}) };
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
  // Desembrulha wrappers (ver-uma-vez / temporária / doc-com-legenda / editada) → o nó real.
  const message = unwrapMessage(asRecord(data["message"]));

  // Grupo (@g.us): o remetente é o `participant`, não o `remoteJid` (que é o grupo).
  // Em grupo migrado pra LID (`addressingMode: "lid"`), `participant` vem como
  // `@lid` (id opaco, não telefone) — a Evolution revela o telefone REAL de quem
  // manda em `participantAlt` (privacidade: só o SEU telefone é revelado a quem
  // recebe sua mensagem; terceiros mencionados/citados continuam só como LID).
  // Prefere Alt; cai pro participant puro (grupo não-LID, onde já é phone-based).
  // Sem telefone identificável não dá pra rotear → ignora.
  let from: string | null;
  let group: InboundGroupContext | undefined;
  if (remoteJid.endsWith(GROUP_SUFFIX)) {
    const participantAlt = typeof key["participantAlt"] === "string" ? (key["participantAlt"] as string) : "";
    const participant = typeof key["participant"] === "string" ? (key["participant"] as string) : "";
    const senderPhone = jidToE164(participantAlt) ?? jidToE164(participant);
    if (!senderPhone) return null;
    from = senderPhone;
    group = buildGroupContext(remoteJid, senderPhone, data, message);
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

  // Chave crua p/ re-buscar mídia por fora do webhook (áudio ptt / imagem sem base64 inline).
  // Grupo: a Evolution exige `participant` (JID de quem mandou dentro do grupo) — doc oficial.
  const buildMediaKey = (): MediaMessageKey => {
    const participant = group && typeof key["participant"] === "string" ? (key["participant"] as string) : undefined;
    return {
      id: messageId,
      remoteJid: key["remoteJid"] as string,
      fromMe: false,
      ...(participant ? { participant } : {}),
    };
  };

  const audio = extractAudio(message, data);
  if (audio) return { ...base, kind: "audio", audio, messageKey: buildMediaKey() };

  const image = extractImage(message, data);
  if (image) {
    const { caption, ...bytes } = image;
    return { ...base, kind: "image", image: bytes, caption, messageKey: buildMediaKey() };
  }

  const video = extractVideo(message);
  if (video) {
    return {
      ...base,
      kind: "video",
      video: { mimetype: video.mimetype, ...(video.fileLength !== undefined ? { fileLength: video.fileLength } : {}) },
      caption: video.caption,
      messageKey: buildMediaKey(),
    };
  }

  // Vídeo/imagem mandados COMO DOCUMENTO (mimetype de mídia) → 1ª classe, não "unsupported".
  const docMedia = extractDocumentMedia(message, data);
  if (docMedia?.kind === "video") {
    return {
      ...base,
      kind: "video",
      video: { mimetype: docMedia.mimetype, ...(docMedia.fileLength !== undefined ? { fileLength: docMedia.fileLength } : {}) },
      caption: docMedia.caption,
      messageKey: buildMediaKey(),
    };
  }
  if (docMedia?.kind === "image") {
    return {
      ...base,
      kind: "image",
      image: { base64: docMedia.base64, mimetype: docMedia.mimetype },
      caption: docMedia.caption,
      messageKey: buildMediaKey(),
    };
  }

  const mediaType = detectMediaType(message);
  if (mediaType) return { ...base, kind: "unsupported", mediaType };

  return null; // sem conteúdo reconhecível (ACK/status/etc) → silêncio
}
