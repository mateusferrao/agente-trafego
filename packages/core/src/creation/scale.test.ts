import { describe, expect, it } from "vitest";
import { planScaleMove } from "./scale.js";

describe("planScaleMove", () => {
  it("CBO (budget na campanha) → sempre sobe o budget da campanha", () => {
    const move = planScaleMove({ scalePct: 50, maxBudgetChangePct: 20, budgetLevel: "campaign" });
    expect(move).toEqual({ move: "raise_budget", pct: 50, level: "campaign" });
  });

  it("ABO + passo dentro da faixa segura → sobe o budget do adset", () => {
    const move = planScaleMove({ scalePct: 15, maxBudgetChangePct: 20, budgetLevel: "adset" });
    expect(move).toEqual({ move: "raise_budget", pct: 15, level: "adset" });
  });

  it("ABO + passo == teto → ainda sobe budget (limite inclusivo)", () => {
    const move = planScaleMove({ scalePct: 20, maxBudgetChangePct: 20, budgetLevel: "adset" });
    expect(move).toEqual({ move: "raise_budget", pct: 20, level: "adset" });
  });

  it("ABO + passo agressivo (> teto) → duplica o adset pra isolar", () => {
    const move = planScaleMove({ scalePct: 50, maxBudgetChangePct: 20, budgetLevel: "adset" });
    expect(move).toEqual({ move: "duplicate", scalePct: 50 });
  });
});
