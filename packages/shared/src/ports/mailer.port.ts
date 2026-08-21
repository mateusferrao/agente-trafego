/**
 * Borda de email transacional (6b). Dois contratos:
 * - `MailQueuePort` (produtor): enfileira a mensagem — a API depende SÓ disto
 *   (não conhece o provider nem o SDK). Nunca envia inline (evita 500 no request).
 * - `MailerPort` (consumidor): entrega, provider-agnóstico — só o worker o monta.
 *
 * Trocar SES↔Resend↔SMTP = novo adapter de `MailerPort`, sem tocar em quem enfileira.
 */

/** Categoria do email (rótulo p/ log/metrics; não é endereço). */
export type EmailCategory = "auth" | "transactional";

/**
 * Mensagem pronta pra entrega (já renderizada). `type` (não `interface`) p/ ser
 * atribuível a `Record<string, unknown>` como payload de job (gotcha do TS).
 */
export type EmailMessage = {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly category: EmailCategory;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** Entrega (consumidor = worker). Adapter concreto = `@trafego/mailer`. */
export interface MailerPort {
  send(message: EmailMessage): Promise<void>;
}

/** Enfileiramento (produtor = API/worker). Impl sobre `SchedulerPort` (fila BullMQ). */
export interface MailQueuePort {
  enqueue(message: EmailMessage): Promise<void>;
}
