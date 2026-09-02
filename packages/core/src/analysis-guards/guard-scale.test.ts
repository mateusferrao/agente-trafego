import { describe, expect, it } from "vitest";
import type { AnalysisOutput, DecisionEligibility } from "@trafego/shared";
import { guardScaleWithoutSignificance } from "./index.js";

const rec = (over: Partial<AnalysisOutput["recommendations"][number]>): AnalysisOutput["recommendations"][number] => ({
  id: "r1",
  title: "t",
  rationale: "porque sim",
  priority: "high",
  actionType: "increase_budget",
  targetEntity: { level: "campaign", externalId: "C1" },
  budgetChangePct: 20,
  expectedImpact: null,
  whatToMonitor: null,
  findingRefs: null,
  ...over,
});

const output = (recs: AnalysisOutput["recommendations"]): AnalysisOutput => ({
  scorecard: { grade: "B", headline: "h", biggestLeak: "conversao" },
  summary: "s",
  findings: [],
  recommendations: recs,
});

const elig = (o: Partial<DecisionEligibility>): DecisionEligibility => ({
  hasSignificance: true,
  inLearning: false,
  conversions: 30,
  clicks: 200,
  ...o,
});

describe("guardScaleWithoutSignificance", () => {
  it("rebaixa escalar sem significância → investigar", () => {
    const out = guardScaleWithoutSignificance(output([rec({})]), new Map([["C1", elig({ hasSignificance: false, conversions: 3 })]]));
    expect(out.recommendations[0]!.actionType).toBe("investigate");
    expect(out.recommendations[0]!.rationale).toContain("3 conversões");
    expect(out.recommendations[0]!.budgetChangePct).toBeNull();
  });

  it("rebaixa escalar em learning → investigar", () => {
    const out = guardScaleWithoutSignificance(output([rec({ actionType: "resume" })]), new Map([["C1", elig({ inLearning: true })]]));
    expect(out.recommendations[0]!.actionType).toBe("investigate");
    expect(out.recommendations[0]!.rationale).toContain("aprendizado");
  });

  it("não mexe em escalar COM significância", () => {
    const out = guardScaleWithoutSignificance(output([rec({})]), new Map([["C1", elig({})]]));
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("nunca barra ações defensivas (pausar/reduzir)", () => {
    const out = guardScaleWithoutSignificance(output([rec({ actionType: "pause" }), rec({ actionType: "decrease_budget" })]), new Map([["C1", elig({ hasSignificance: false })]]));
    expect(out.recommendations[0]!.actionType).toBe("pause");
    expect(out.recommendations[1]!.actionType).toBe("decrease_budget");
  });

  it("sem eligibility conhecida → não mexe", () => {
    const out = guardScaleWithoutSignificance(output([rec({})]), new Map());
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("título ganha prefixo 'Investigar: ' quando rebaixa (headline não fica desalinhado da ação real)", () => {
    const out = guardScaleWithoutSignificance(
      output([rec({ title: "Escalar campanha X" })]),
      new Map([["C1", elig({ hasSignificance: false, conversions: 3 })]]),
    );
    expect(out.recommendations[0]!.title).toBe("Investigar: Escalar campanha X");
  });
});
