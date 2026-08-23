import { describe, expect, it } from "vitest";
import { TYPING_MAX_MS, TYPING_MIN_MS, computeTypingHint } from "./typing.js";

describe("computeTypingHint", () => {
  it("balão curtíssimo respeita o piso", () => {
    expect(computeTypingHint("ok")).toBe(TYPING_MIN_MS);
  });

  it("balão longo é limitado pelo teto", () => {
    expect(computeTypingHint("x".repeat(1000))).toBe(TYPING_MAX_MS);
  });

  it("é proporcional ao tamanho na faixa média (mais chars = mais tempo)", () => {
    const curto = computeTypingHint("x".repeat(50));
    const medio = computeTypingHint("x".repeat(120));
    expect(medio).toBeGreaterThan(curto);
    expect(curto).toBeGreaterThanOrEqual(TYPING_MIN_MS);
    expect(medio).toBeLessThanOrEqual(TYPING_MAX_MS);
  });
});
