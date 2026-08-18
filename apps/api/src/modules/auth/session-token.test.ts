import { describe, expect, it } from "vitest";
import {
  computeSessionExpiry,
  generateSessionToken,
  hashSessionToken,
  SESSION_TTL_MS,
} from "./session-token.js";

describe("session-token", () => {
  it("gera tokens distintos e não-triviais", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("hash é sha256 hex (64 chars), determinístico e diferente do token", () => {
    const token = generateSessionToken();
    const h1 = hashSessionToken(token);
    const h2 = hashSessionToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(token);
  });

  it("expiry = now + TTL", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(computeSessionExpiry(now).getTime()).toBe(now.getTime() + SESSION_TTL_MS);
  });
});
