import type { EmailMessage, MailerPort } from "@trafego/shared/ports";

/**
 * Driver de DEV: não envia — loga a mensagem (inclui o corpo em texto, onde vive
 * o código/link) p/ o desenvolvedor pegar sem provider real. `log` injetável
 * (default `console.info`) p/ casar com o logger do worker.
 */
export class ConsoleMailer implements MailerPort {
  constructor(private readonly log: (msg: string) => void = (m) => console.info(m)) {}

  async send(message: EmailMessage): Promise<void> {
    this.log(
      `[mailer:console] to=${message.to} subject="${message.subject}" category=${message.category}\n${message.text}`,
    );
  }
}
