import { describe, expect, it } from "vitest";
import { checkPasswordStrength } from "./index.js";

describe("checkPasswordStrength", () => {
  it("aceita senha com >=8 chars, letra e número", () => {
    expect(checkPasswordStrength("s3nhaforte")).toEqual({ ok: true });
  });

  it("rejeita curta (<8)", () => {
    expect(checkPasswordStrength("s3nha")).toEqual({ ok: false, reason: "too_short" });
  });

  it("rejeita sem número", () => {
    expect(checkPasswordStrength("senhasemnumero")).toEqual({ ok: false, reason: "no_number" });
  });

  it("rejeita sem letra", () => {
    expect(checkPasswordStrength("12345678")).toEqual({ ok: false, reason: "no_letter" });
  });
});
