import { describe, expect, it } from "vitest";
import { isOverCostCap, resolveCostCapUsd } from "./index.js";

describe("resolveCostCapUsd", () => {
  it("usa o cap por-org quando > 0", () => {
    expect(resolveCostCapUsd(50, 10)).toBe(50);
  });
  it("cai p/ o env quando o cap por-org é 0/ausente", () => {
    expect(resolveCostCapUsd(0, 10)).toBe(10);
    expect(resolveCostCapUsd(null, 10)).toBe(10);
    expect(resolveCostCapUsd(undefined, 10)).toBe(10);
  });
});

describe("isOverCostCap", () => {
  it("sem cap (0) nunca bloqueia", () => {
    expect(isOverCostCap(999, 0)).toBe(false);
  });
  it("bloqueia quando gasto >= cap", () => {
    expect(isOverCostCap(10, 10)).toBe(true);
    expect(isOverCostCap(11, 10)).toBe(true);
  });
  it("libera quando gasto < cap", () => {
    expect(isOverCostCap(9.99, 10)).toBe(false);
  });
  it("custo ausente = fail-open (não bloqueia)", () => {
    expect(isOverCostCap(null, 10)).toBe(false);
    expect(isOverCostCap(undefined, 10)).toBe(false);
  });
});
