import { describe, expect, it } from "vitest";
import type { AnalysisOutput, ConversionBasis, TrackingHealth } from "@trafego/shared";
import { guardTrackingCaveat } from "./index.js";

const rec = (over: Partial<AnalysisOutput["recommendations"][number]>): AnalysisOutput["recommendations"][number] => ({
  id: "r1",
  title: "t",
  rationale: "CPA de venda muito alto",
  priority: "high",
  actionType: "pause",
  targetEntity: { level: "campaign", externalId: "C1" },
  budgetChangePct: null,
  expectedImpact: null,
  whatToMonitor: null,
  findingRefs: null,
  ...over,
});

const output = (recs: AnalysisOutput["recommendations"]): AnalysisOutput => ({
  scorecard: { grade: "C", headline: "h", biggestLeak: "conversao" },
  summary: "s",
  findings: [],
  recommendations: recs,
});

const suspect: TrackingHealth = { suspect: true, funnelStarted: 2896, trackedConversions: 8, ratio: 362 };

describe("guardTrackingCaveat", () => {
  it("rebaixa a pausa por CPA de venda em entidade base target → investigate, com razão anexada", () => {
    const out = guardTrackingCaveat(output([rec({})]), new Map<string, ConversionBasis>([["C1", "target"]]), suspect);
    expect(out.recommendations[0]!.actionType).toBe("investigate");
    expect(out.recommendations[0]!.rationale).toContain("medição de vendas parece incompleta");
    expect(out.recommendations[0]!.rationale).toContain("[guard]");
  });

  it("também rebaixa decrease_budget (não só pause)", () => {
    const out = guardTrackingCaveat(
      output([rec({ actionType: "decrease_budget" })]),
      new Map<string, ConversionBasis>([["C1", "target"]]),
      suspect,
    );
    expect(out.recommendations[0]!.actionType).toBe("investigate");
  });

  it("título ganha prefixo 'Investigar: ' quando rebaixa", () => {
    const out = guardTrackingCaveat(
      output([rec({ title: "Pausar campanha X" })]),
      new Map<string, ConversionBasis>([["C1", "target"]]),
      suspect,
    );
    expect(out.recommendations[0]!.title).toBe("Investigar: Pausar campanha X");
  });

  it("não toca entidade base proxy (já não é julgada por venda)", () => {
    const out = guardTrackingCaveat(output([rec({})]), new Map<string, ConversionBasis>([["C1", "proxy"]]), suspect);
    expect(out.recommendations[0]!.rationale).toBe("CPA de venda muito alto");
  });

  it("não toca ações que não matam (ex: increase_budget)", () => {
    const out = guardTrackingCaveat(
      output([rec({ actionType: "increase_budget" })]),
      new Map<string, ConversionBasis>([["C1", "target"]]),
      suspect,
    );
    expect(out.recommendations[0]!.rationale).toBe("CPA de venda muito alto");
  });

  it("sem sinal suspeito → passa direto", () => {
    const out = guardTrackingCaveat(output([rec({})]), new Map<string, ConversionBasis>([["C1", "target"]]), undefined);
    expect(out.recommendations[0]!.rationale).toBe("CPA de venda muito alto");
  });
});
