import { describe, expect, it } from "vitest";
import { hashVerificationCode, isCodeValid } from "./service.js";

const NOW = 1_000_000;
const FUTURE = new Date(NOW + 60_000);
const PAST = new Date(NOW - 1);

describe("isCodeValid", () => {
  it("aceita o código correto dentro da validade", () => {
    const stored = { codeHash: hashVerificationCode("123456"), expiresAt: FUTURE };
    expect(isCodeValid(stored, "123456", NOW)).toBe(true);
  });

  it("rejeita código errado", () => {
    const stored = { codeHash: hashVerificationCode("123456"), expiresAt: FUTURE };
    expect(isCodeValid(stored, "000000", NOW)).toBe(false);
  });

  it("rejeita código expirado (mesmo correto)", () => {
    const stored = { codeHash: hashVerificationCode("123456"), expiresAt: PAST };
    expect(isCodeValid(stored, "123456", NOW)).toBe(false);
  });

  it("rejeita quando não há código pendente", () => {
    expect(isCodeValid({ codeHash: null, expiresAt: null }, "123456", NOW)).toBe(false);
  });
});
