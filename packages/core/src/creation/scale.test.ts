import { describe, expect, it } from "vitest";
import type { CampaignDraft } from "@trafego/shared";
import { buildDuplicateInput, planScaleMove } from "./scale.js";

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

describe("buildDuplicateInput", () => {
  const draft: CampaignDraft = {
    kind: "duplicate",
    sourceRef: { level: "adset", id: "AS1" },
    spec: { version: 1, currency: "BRL", dailyBudgetMinor: 9000, activation: "active" },
  };

  it("mapeia sourceRef + budget novo + ativação p/ a entrada de duplicação", () => {
    expect(buildDuplicateInput(draft)).toEqual({
      sourceLevel: "adset",
      sourceId: "AS1",
      newDailyBudgetMinor: 9000,
      status: "active",
      renameSuffix: "escala",
    });
  });

  it("lança se o rascunho não é de duplicação", () => {
    const fromScratch: CampaignDraft = { kind: "from_scratch", spec: draft.spec };
    expect(() => buildDuplicateInput(fromScratch)).toThrow();
  });
});
