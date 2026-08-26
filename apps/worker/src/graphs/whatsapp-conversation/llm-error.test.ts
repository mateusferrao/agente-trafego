import { describe, expect, it } from "vitest";
import { describeLlmError } from "./llm-error.js";

describe("describeLlmError", () => {
  it("TypeError de parse (o caso do fallback): name + message + stack apontando o frame", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'message')");
    const d = describeLlmError(err);
    expect(d.name).toBe("TypeError");
    expect(d.message).toContain("reading 'message'");
    expect(typeof d.stack).toBe("string");
    // sem campos HTTP num erro de parse puro
    expect(d.status).toBeUndefined();
    expect(d.body).toBeUndefined();
  });

  it("APIError do SDK: extrai status + corpo cru do provider", () => {
    const err = Object.assign(new Error("429 rate limited"), {
      status: 429,
      code: "rate_limit_exceeded",
      error: { message: "slow down", provider: "google" },
    });
    const d = describeLlmError(err);
    expect(d.status).toBe(429);
    expect(d.code).toBe("rate_limit_exceeded");
    expect(d.body).toEqual({ message: "slow down", provider: "google" });
  });

  it("response.data (axios-like) vira body; trunca corpo gigante", () => {
    const big = "x".repeat(5000);
    const err = Object.assign(new Error("boom"), { response: { status: 502, data: big } });
    const d = describeLlmError(err);
    expect(d.httpStatus).toBe(502);
    expect(String(d.body)).toContain("+3800 chars");
  });

  it("não-Error: cai em raw", () => {
    expect(describeLlmError("plain string")).toEqual({ raw: "plain string" });
  });
});
