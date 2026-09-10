import { describe, expect, it } from "vitest";
import { reallocKindPeriod } from "./write-context.js";

describe("reallocKindPeriod (compatibilidade de tipo de orçamento na realocação)", () => {
  it("ambos diários → ok, período '/dia'", () => {
    expect(reallocKindPeriod("daily", "daily")).toEqual({ ok: true, period: "/dia" });
  });
  it("ambos vitalícios → ok, período ' no total'", () => {
    expect(reallocKindPeriod("lifetime", "lifetime")).toEqual({ ok: true, period: " no total" });
  });
  it("tipos diferentes → incompatível (não dá pra mover /dia de um total)", () => {
    expect(reallocKindPeriod("daily", "lifetime")).toEqual({ ok: false });
    expect(reallocKindPeriod("lifetime", "daily")).toEqual({ ok: false });
  });
});
