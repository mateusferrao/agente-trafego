import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { EmailMessage, MailerPort } from "@trafego/shared/ports";

const CHARSET = "UTF-8";

/**
 * Driver de PRODUÇÃO: AWS SESv2. Creds vêm da cadeia default do SDK
 * (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY do env — IAM escopado a ses:SendEmail).
 * Região = a do SES verificado (sa-east-1). Falha de envio propaga → retry da fila.
 */
export class SesMailer implements MailerPort {
  private readonly client: SESv2Client;

  constructor(region: string) {
    this.client = new SESv2Client({ region });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: CHARSET },
            Body: {
              Text: { Data: message.text, Charset: CHARSET },
              Html: { Data: message.html, Charset: CHARSET },
            },
          },
        },
      }),
    );
  }
}
