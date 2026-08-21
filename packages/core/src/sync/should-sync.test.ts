import { describe, expect, it } from "vitest";
import { shouldSync } from "./index.js";

// now fixo (injetado) → determinístico. threshold = 120 min nos casos abaixo.
const NOW = Date.UTC(2026, 7, 18, 14, 0, 0); // 2026-08-18 14:00:00 UTC
const MIN = 60_000;

describe("shouldSync", () => {
  it("nunca sincronizado (latest null) → true", () => {
    expect(shouldSync({ latestSnapshotAt: null, now: NOW, thresholdMin: 120 })).toBe(true);
  });

  it("fresco (idade < limite) → false", () => {
    expect(shouldSync({ latestSnapshotAt: NOW - 30 * MIN, now: NOW, thresholdMin: 120 })).toBe(false);
  });

  it("exatamente no limite → true (>=)", () => {
    expect(shouldSync({ latestSnapshotAt: NOW - 120 * MIN, now: NOW, thresholdMin: 120 })).toBe(true);
  });

  it("velho (idade > limite) → true", () => {
    expect(shouldSync({ latestSnapshotAt: NOW - 200 * MIN, now: NOW, thresholdMin: 120 })).toBe(true);
  });

  it("latest no futuro (clock skew) → false (tratado como fresco)", () => {
    expect(shouldSync({ latestSnapshotAt: NOW + 10 * MIN, now: NOW, thresholdMin: 120 })).toBe(false);
  });
});
