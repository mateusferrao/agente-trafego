import type { MailerPort } from "@trafego/shared/ports";
import { ConsoleMailer } from "./console.mailer.js";
import { SesMailer } from "./ses.mailer.js";
import { MisconfiguredMailer } from "./misconfigured.mailer.js";

export { ConsoleMailer } from "./console.mailer.js";
export { SesMailer } from "./ses.mailer.js";
export { MisconfiguredMailer } from "./misconfigured.mailer.js";

export type MailerDriver = "console" | "ses" | "noop";

export interface MailerConfig {
  readonly driver: MailerDriver;
  /** Região do SES (só usada pelo driver `ses`). */
  readonly region: string;
  /** Logger opcional p/ o driver `console` (default `console.info`). */
  readonly log?: (msg: string) => void;
}

/**
 * Factory por config (a composition do worker passa o env). Driver desconhecido
 * ou não implementado → `MisconfiguredMailer` (falha por-job, não no boot).
 * `noop` = descarta (útil em testes que não querem side-effect).
 */
export function createMailer(config: MailerConfig): MailerPort {
  switch (config.driver) {
    case "console":
      return new ConsoleMailer(config.log);
    case "ses":
      return new SesMailer(config.region);
    case "noop":
      return { async send() {} };
    default:
      return new MisconfiguredMailer(`driver desconhecido: ${String(config.driver)}`);
  }
}
