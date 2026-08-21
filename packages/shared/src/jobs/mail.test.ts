import { describe, expect, it } from "vitest";
import { buildMailJob, MAIL_QUEUE, MAIL_JOB } from "./mail.js";
import type { EmailMessage } from "../ports/mailer.port.js";

const MSG: EmailMessage = {
  to: "user@example.com",
  from: "no-reply@msg.automato.pro",
  subject: "Seu código",
  text: "123456",
  html: "<p>123456</p>",
  category: "auth",
};

describe("buildMailJob", () => {
  it("monta o JobSpec da fila de email com retry", () => {
    const job = buildMailJob(MSG);
    expect(job.queue).toBe(MAIL_QUEUE);
    expect(job.name).toBe(MAIL_JOB);
    expect(job.payload).toBe(MSG);
    expect(job.attempts).toBe(5);
    expect(job.backoffMs).toBe(5000);
    expect(job.removeOnComplete).toBe(true);
  });
});
