export interface ChannelInstanceRef {
  readonly instanceId: string;
  /** Secret por-instância p/ o header do webhook (usado só no registro em `connect`). */
  readonly webhookSecret?: string;
}

export interface OutboundMessage {
  readonly to: string; // telefone E.164, ou JID de grupo quando `toIsGroup`
  /** Destino é um GRUPO (`to` = JID @g.us), não um telefone. Ausente/false = DM. */
  readonly toIsGroup?: boolean;
  readonly text: string;
  /**
   * Dica NEUTRA de tempo de "preparo" antes de entregar a mensagem (ms) — dá o
   * ritmo humano de conversa. O adapter TRADUZ p/ o recurso do canal (Evolution:
   * `presence: composing` + `delay` = "digitando…"); um canal sem esse recurso
   * pode emular ou ignorar. Ausente/0 = entrega imediata. Vocabulário do provider
   * (composing/typing) vive SÓ no adapter (§5).
   */
  readonly typingHintMs?: number;
}

/**
 * Contexto de GRUPO de uma mensagem inbound (ausente = DM 1:1). Campos NEUTROS
 * extraídos pelo adapter — quem é o bot e se a mensagem "dirige" o bot é decidido
 * na casca (worker), comparando com o telefone da instância. `senderPhone` = quem
 * mandou (o `from` da base espelha isso no grupo); `mentionedPhones` = telefones
 * marcados (@); `quotedAuthorPhone` = autor da mensagem citada (reply), quando houver.
 *
 * `mentionedLids`/`quotedAuthorLid`: em grupo migrado pro endereçamento por LID
 * (id interno opaco, não reversível pra telefone), a menção/reply pode vir SÓ como
 * LID — sem contrapartida telefone no próprio payload da mensagem (o WhatsApp só
 * revela o telefone real de quem MANDA, nunca de terceiros mencionados/citados).
 * Preserva o LID cru pra casca resolver via `resolveGroupParticipants` (fallback,
 * best-effort) quando o telefone direto não bastar.
 */
export interface InboundGroupContext {
  readonly groupJid: string;
  readonly senderPhone: string;
  /** Nome de exibição do remetente no grupo (pushName do WhatsApp) — atribuição legível
   *  no transcript de contexto. Null quando o provider não informa. */
  readonly senderName: string | null;
  readonly mentionedPhones: readonly string[];
  readonly quotedAuthorPhone: string | null;
  readonly mentionedLids: readonly string[];
  readonly quotedAuthorLid: string | null;
}

/** Campos comuns a toda mensagem inbound (independe do tipo de mídia). */
export interface InboundMessageBase {
  readonly instanceId: string;
  readonly from: string; // telefone E.164 (no grupo = telefone do participante remetente)
  /** id da mensagem no provider (Evolution `data.key.id`) — idempotência do inbound. */
  readonly messageId: string;
  /** Presente só em mensagens de GRUPO (DM = ausente). Ortogonal ao `kind`. */
  readonly group?: InboundGroupContext;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Mensagem de texto (conversation / extendedTextMessage). */
export interface InboundTextMessage extends InboundMessageBase {
  readonly kind: "text";
  readonly text: string;
}

/** Key cru da mensagem no provider — único jeito de re-buscar a mídia por fora do webhook. */
export interface MediaMessageKey {
  readonly id: string;
  readonly remoteJid: string;
  readonly fromMe: boolean;
  /** JID de quem mandou DENTRO do grupo (Evolution exige p/ mídia de grupo). Ausente em DM. */
  readonly participant?: string;
}

/** Nota de voz / áudio — bytes inline (base64) p/ transcrição na borda. */
export interface InboundAudioMessage extends InboundMessageBase {
  readonly kind: "audio";
  readonly audio: { readonly base64: string; readonly mimetype: string };
  /** p/ `fetchMediaBase64` quando o webhook não entrega o base64 inline (quirk do ptt). */
  readonly messageKey: MediaMessageKey;
}

/** Mídia reconhecida mas não-suportada (imagem/vídeo/doc/figurinha) — vira aviso, não drop. */
export interface InboundUnsupportedMessage extends InboundMessageBase {
  readonly kind: "unsupported";
  readonly mediaType: string; // rótulo neutro: "image" | "video" | "document" | "sticker" | ...
}

/**
 * Mensagem inbound normalizada (união discriminada por `kind`). Áudio é
 * transcrito → texto na borda; mídia não-suportada vira aviso amigável; o resto
 * (fromMe/grupo/ACK/sem conteúdo) o parser devolve como `null` (silêncio).
 */
export type InboundMessage = InboundTextMessage | InboundAudioMessage | InboundUnsupportedMessage;

/** Grupo do WhatsApp em que o número da org já está (registro — G4). */
export interface GroupSummary {
  readonly jid: string;
  readonly name: string | null;
  readonly size?: number;
}

export type InstanceStatus = "disconnected" | "connecting" | "connected";

export interface InstanceState {
  readonly status: InstanceStatus;
  readonly qrCode?: string; // base64 quando connecting
  readonly phone?: string;
}

/**
 * Erro neutro de canal de mensageria. O adapter (Evolution) traduz seu erro
 * específico (HTTP/rede) para esta forma; a casca mapeia p/ HTTP amigável **sem**
 * conhecer o provider (mesmo padrão de `AdsPlatformError`). `unavailable` = não
 * consegui falar com o canal agora (rede/instância fora).
 */
export type MessagingChannelErrorKind = "unavailable";

export class MessagingChannelError extends Error {
  constructor(
    readonly kind: MessagingChannelErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MessagingChannelError";
  }
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
  /** Extrai o status de um evento de conexão do webhook (ou null se não for). */
  parseConnectionUpdate(payload: unknown): InstanceStatus | null;
  connect(instance: ChannelInstanceRef): Promise<InstanceState>;
  getState(instance: ChannelInstanceRef): Promise<InstanceState>;
  /**
   * Grupos em que o número JÁ está (a org adiciona o bot manualmente — sem convite
   * automático, fast-follow). Usado só no registro (G4); não confundir com
   * `channel_groups` (o grupo REGISTRADO pela org, que este endpoint não conhece).
   */
  listGroups(instance: ChannelInstanceRef): Promise<GroupSummary[]>;
  /** Desfaz o pareamento do número (logout), mantendo a instância p/ re-parear. */
  disconnect(instance: ChannelInstanceRef): Promise<void>;
  /**
   * Re-registra o webhook da instância já pareada (mesma config do `connect`) —
   * usado por backfills one-time quando a config do webhook muda (ex: passar a
   * pedir mídia em base64) e instâncias já conectadas ficam com a versão antiga
   * até re-parear. Best-effort: nunca lança.
   */
  syncWebhook(instance: ChannelInstanceRef): Promise<void>;
  /**
   * Busca o base64 decriptado de uma mídia direto na Evolution — fallback pro caso
   * do webhook não entregar inline (quirk observado em áudio/`ptt` mesmo com o
   * webhook pedindo base64). Best-effort: `null` em qualquer falha, nunca lança.
   */
  fetchMediaBase64(instance: ChannelInstanceRef, key: MediaMessageKey): Promise<string | null>;
  /**
   * Mapa LID→telefone (E.164) dos participantes de um grupo — resolve menção/reply
   * endereçada por LID (grupo migrado, `InboundGroupContext.mentionedLids`/
   * `quotedAuthorLid`) quando o telefone não veio direto na mensagem. Best-effort:
   * `{}` em qualquer falha, nunca lança (é fallback; a casca cacheia o resultado).
   */
  resolveGroupParticipants(instance: ChannelInstanceRef, groupJid: string): Promise<Record<string, string>>;
}
