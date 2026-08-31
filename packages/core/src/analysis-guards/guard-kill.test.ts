import { describe, expect, it } from "vitest";
import type { AnalysisOutput, DecisionEligibility } from "@trafego/shared";
import { guardKillWithoutMaturity } from "./index.js";

const rec = (over: Partial<AnalysisOutput["recommendations"][number]>): AnalysisOutput["recommendations"][number] => ({
  id: "r1",
  title: "t",
  rationale: "sem resultado",
  priority: "high",
  actionType: "pause",
  targetEntity: { level: "campaign", externalId: "C1" },
  budgetChangePct: null,
  ...over,
});

const output = (recs: AnalysisOutput["recommendations"]): AnalysisOutput => ({
  scorecard: { grade: "C", headline: "h", biggestLeak: "conversao" },
  summary: "s",
  findings: [],
  recommendations: recs,
});

const elig = (o: Partial<DecisionEligibility>): DecisionEligibility => ({
  hasSignificance: false,
  inLearning: false,
  conversions: 2,
  clicks: 30,
  ...o,
});

describe("guardKillWithoutMaturity", () => {
  it("rebaixa pausar em learning → investigar (não descarta o aprendizado)", () => {
    const out = guardKillWithoutMaturity(output([rec({})]), new Map([["C1", elig({ inLearning: true })]]));
    expect(out.recommendations[0]!.actionType).toBe("investigate");
    expect(out.recommendations[0]!.rationale).toContain("aprendizado");
  });

  it("não mexe em pausar FORA de learning (zumbi maduro pode ser pausado)", () => {
    const out = guardKillWithoutMaturity(output([rec({})]), new Map([["C1", elig({ inLearning: false })]]));
    expect(out.recommendations[0]!.actionType).toBe("pause");
  });

  it("não toca ações que não matam (decrease_budget) mesmo em learning", () => {
    const out = guardKillWithoutMaturity(
      output([rec({ actionType: "decrease_budget" })]),
      new Map([["C1", elig({ inLearning: true })]]),
    );
    expect(out.recommendations[0]!.actionType).toBe("decrease_budget");
  });

  it("sem eligibility conhecida → não mexe", () => {
    const out = guardKillWithoutMaturity(output([rec({})]), new Map());
    expect(out.recommendations[0]!.actionType).toBe("pause");
  });

  it("título ganha prefixo 'Investigar: ' quando rebaixa; budgetChangePct zera (consistente com os demais guards)", () => {
    const out = guardKillWithoutMaturity(
      output([rec({ title: "Pausar campanha X", budgetChangePct: -50 })]),
      new Map([["C1", elig({ inLearning: true })]]),
    );
    expect(out.recommendations[0]!.title).toBe("Investigar: Pausar campanha X");
    expect(out.recommendations[0]!.budgetChangePct).toBeNull();
  });
});
