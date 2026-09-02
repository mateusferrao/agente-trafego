/**
 * Contrato do job de inbound do WhatsApp (Evolution), compartilhado entre o produtor
 * (API — valida o secret da instância e enfileira o payload CRU) e o consumidor
 * (worker — normaliza via `parseInbound`, resolve contato e roteia p/ o Grafo B).
 * Enfileirar cru mantém a casca fina (200 rápido) e a lógica de agente fora da API (§7/§9).
 */
export const WHATSAPP_INBOUND_QUEUE = "whatsapp-inbound";
export const WHATSAPP_INBOUND_JOB = "process-inbound";

/** Payload cru do webhook Evolution (o worker é quem parseia). */
export type WhatsappInboundPayload = {
  readonly instanceId: string;
  readonly raw: Readonly<Record<string, unknown>>;
};

/**
 * Referência de identidade/entrega de uma conversa: DM (contato verificado) ou GRUPO
 * (participante, sem verificação — a adesão ao grupo é a fronteira de confiança). Thread
 * por-(grupo, participante) → "só o iniciador confirma" + foco por participante de graça.
 * Discriminada p/ o worker escolher o alvo de entrega (telefone × JID do grupo) e o ator.
 */
export type ConversationRef =
  | { readonly kind: "contact"; readonly contactId: string }
  // `participantPhone`: string = turno reativo (thread por participante, dá "só o
  // iniciador confirma"); null = proativo/broadcast do agente pro grupo (sem
  // participante específico — pulso/alerta/push do cron).
  | { readonly kind: "group"; readonly groupId: string; readonly participantPhone: string | null };

/**
 * Fila de FLUSH do debounce (5b-2.4): o inbound bufferiza as mensagens picadas e
 * agenda um flush atrasado (jobId = conversationId, re-agendado a cada fragmento).
 * Ao disparar, o flush coalesce o buffer num único turno do Grafo B. Serializa por
 * conversa (1 job por thread) — sem corrida no checkpointer.
 */
export const WHATSAPP_FLUSH_QUEUE = "whatsapp-flush";
export const WHATSAPP_FLUSH_JOB = "flush-conversation";
export type WhatsappFlushPayload = {
  readonly orgId: string;
  readonly conversationId: string;
  readonly ref: ConversationRef;
};

/**
 * Fila DEDICADA de transcrição de nota de voz (áudio → texto na borda). O inbound
 * detecta áudio, marca a flag `wa:transcribing` (segura o flush) e enfileira aqui;
 * o worker transcreve, grava o texto na linha da mensagem, mede o custo e empurra
 * o texto no buffer do debounce (coalesce com texto picado) — ou avisa em falha.
 */
export const WHATSAPP_TRANSCRIPTION_QUEUE = "whatsapp-transcription";
export const WHATSAPP_TRANSCRIPTION_JOB = "transcribe-audio";
/** Retentativas da transcrição (só erros transitórios re-tentam — ver worker). */
export const WHATSAPP_TRANSCRIPTION_ATTEMPTS = 3;
/** Base do backoff exponencial entre tentativas de transcrição (ms). */
export const WHATSAPP_TRANSCRIPTION_BACKOFF_MS = 3_000;
export type WhatsappTranscriptionPayload = {
  readonly orgId: string;
  readonly ref: ConversationRef;
  readonly conversationId: string;
  /** id da LINHA da mensagem (messages.id) — update por PK após transcrever. Ausente no
   *  caso de ÁUDIO CITADO (reply a áudio marcando o bot): não há linha própria a atualizar. */
  readonly messageRowId?: string;
  /** instância Evolution dona da mensagem — p/ o fallback `fetchMediaBase64`. */
  readonly instanceId: string;
  readonly audio: {
    readonly base64: string;
    readonly mimetype: string;
    /** key cru da mensagem — usado se `base64` vier vazio (fallback) OU p/ áudio citado.
     *  `participant` = autor (necessário p/ mídia de grupo). */
    readonly messageKey: { readonly id: string; readonly remoteJid: string; readonly fromMe: boolean; readonly participant?: string };
  };
  /** ÁUDIO CITADO (b): transcreve o áudio que o usuário respondeu e prefixa no turno,
   *  junto do texto que ele digitou. Ausente = transcrição normal (nota de voz própria). */
  readonly quotedAudioContext?: {
    readonly userText: string;
    readonly authorLabel: string;
  };
};

/**
 * Fila DEDICADA de intake de imagem (Fatia 7): o inbound detecta imagem, enfileira
 * aqui; o worker resolve os bytes (inline ou `fetchMediaBase64`), grava o blob no
 * StoragePort, sobe pra Meta (image_hash), registra o `creative_asset` (origin=upload)
 * na conta em foco e responde "recebi, guardei". Imagem NÃO dispara turno do Grafo B —
 * é side-effect + cortesia. Conta em foco ausente (org multi-conta) → pede antes de subir.
 */
export const WHATSAPP_MEDIA_INTAKE_QUEUE = "whatsapp-media-intake";
export const WHATSAPP_MEDIA_INTAKE_JOB = "intake-media";
/** Retentativas do intake (erros transitórios: fetch/upload). */
export const WHATSAPP_MEDIA_INTAKE_ATTEMPTS = 3;
/** Base do backoff exponencial entre tentativas de intake (ms). */
export const WHATSAPP_MEDIA_INTAKE_BACKOFF_MS = 3_000;
export type WhatsappMediaIntakePayload = {
  readonly orgId: string;
  readonly ref: ConversationRef;
  readonly conversationId: string;
  readonly instanceId: string;
  readonly mediaType: "image" | "video";
  readonly media: {
    readonly mimetype: string;
    readonly caption: string | null;
    /** base64 inline (imagem, quando o webhook entrega). VÍDEO NÃO carrega base64 (grande demais
     *  p/ o Redis, §9) — o worker busca por `messageKey` (fetchMediaBase64) sob cap de tamanho. */
    readonly base64?: string;
    /** key cru — usado se `base64` vier vazio (fallback `fetchMediaBase64`). */
    readonly messageKey: { readonly id: string; readonly remoteJid: string; readonly fromMe: boolean; readonly participant?: string };
    /** VÍDEO apenas (P0.3): tamanho em bytes já na metadata do WhatsApp — o intake recusa
     *  vídeo grande demais ANTES de baixar/decodificar. Ausente → fallback pós-decode. */
    readonly fileLength?: number;
  };
};
