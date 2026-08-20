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
 * Fila de FLUSH do debounce (5b-2.4): o inbound bufferiza as mensagens picadas e
 * agenda um flush atrasado (jobId = conversationId, re-agendado a cada fragmento).
 * Ao disparar, o flush coalesce o buffer num único turno do Grafo B. Serializa por
 * conversa (1 job por thread) — sem corrida no checkpointer.
 */
export const WHATSAPP_FLUSH_QUEUE = "whatsapp-flush";
export const WHATSAPP_FLUSH_JOB = "flush-conversation";
export type WhatsappFlushPayload = {
  readonly orgId: string;
  readonly contactId: string;
  readonly conversationId: string;
};
