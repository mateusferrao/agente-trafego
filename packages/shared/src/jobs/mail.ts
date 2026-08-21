import type { JobSpec } from "../ports/scheduler.port.js";
import type { EmailMessage } from "../ports/mailer.port.js";

/**
 * Contrato da fila de email (produtor = API/worker; consumidor = worker `mail`).
 * Fila própria (separada de análise/sync) — email é best-effort com retry.
 */
export const MAIL_QUEUE = "core.mail";
export const MAIL_JOB = "mail.send";

/**
 * Monta o `JobSpec` de envio de email. Retry exponencial (5x) — entrega é
 * best-effort; falha transitória (SES/rede) retria sem derrubar o request que
 * enfileirou. `removeOnComplete` limpa; falhas ficam retidas (nº bounded) p/ inspeção.
 * Puro (sem runtime) → DRY entre api e worker, testável.
 */
export function buildMailJob(message: EmailMessage): JobSpec {
  return {
    queue: MAIL_QUEUE,
    name: MAIL_JOB,
    payload: message,
    attempts: 5,
    backoffMs: 5_000,
    removeOnComplete: true,
    removeOnFail: 500,
  };
}
