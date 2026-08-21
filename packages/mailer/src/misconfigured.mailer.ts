import type { EmailMessage, MailerPort } from "@trafego/shared/ports";

/**
 * Driver de fallback: NÃO crasha o boot quando o driver está mal-configurado —
 * só falha DENTRO do `send` (por-job, com retry da fila), preservando o processo.
 */
export class MisconfiguredMailer implements MailerPort {
  constructor(private readonly reason: string) {}

  async send(_message: EmailMessage): Promise<void> {
    throw new Error(`mailer mal-configurado: ${this.reason}`);
  }
}
