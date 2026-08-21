import { describe, expect, it } from "vitest";
import { createMailer, ConsoleMailer, SesMailer, MisconfiguredMailer } from "./index.js";

describe("createMailer (factory por driver)", () => {
  it("console → ConsoleMailer", () => {
    expect(createMailer({ driver: "console", region: "sa-east-1" })).toBeInstanceOf(ConsoleMailer);
  });

  it("ses → SesMailer", () => {
    expect(createMailer({ driver: "ses", region: "sa-east-1" })).toBeInstanceOf(SesMailer);
  });

  it("driver desconhecido → MisconfiguredMailer (não crasha no boot)", () => {
    const mailer = createMailer({ driver: "smtp" as never, region: "sa-east-1" });
    expect(mailer).toBeInstanceOf(MisconfiguredMailer);
  });

  it("MisconfiguredMailer falha só no send", async () => {
    const mailer = createMailer({ driver: "smtp" as never, region: "sa-east-1" });
    await expect(
      mailer.send({ to: "a@b.co", from: "x@y.co", subject: "s", text: "t", html: "<p>t</p>", category: "auth" }),
    ).rejects.toThrow(/mal-configurado/);
  });
});
