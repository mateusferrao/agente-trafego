import { describe, expect, it } from "vitest";
import { webhookBodyLimitBytes } from "./body-limit.js";

const MB = 1024 * 1024;

describe("webhookBodyLimitBytes (fix do 413 — mídia base64 no corpo)", () => {
  it("comporta o maior vídeo aceito em base64 (~4/3) + folga — bem acima do vídeo cru", () => {
    const maxVideoMb = 50;
    const limit = webhookBodyLimitBytes(maxVideoMb);
    // base64 infla ~4/3 → o teto tem que caber o vídeo codificado (senão 413 no vídeo no limite).
    expect(limit).toBeGreaterThanOrEqual(Math.ceil((maxVideoMb * 4) / 3) * MB);
    // ...e não absurdamente alto (endpoint público) — dentro de ~+8 MB de folga do inflado.
    expect(limit).toBeLessThanOrEqual((Math.ceil((maxVideoMb * 4) / 3) + 8) * MB);
  });

  it("é MUITO maior que o default de 1 MB do Fastify (a causa do 413)", () => {
    expect(webhookBodyLimitBytes(50)).toBeGreaterThan(1 * MB);
  });

  it("cresce com o teto de vídeo (deriva da fonte única)", () => {
    expect(webhookBodyLimitBytes(100)).toBeGreaterThan(webhookBodyLimitBytes(50));
  });
});
