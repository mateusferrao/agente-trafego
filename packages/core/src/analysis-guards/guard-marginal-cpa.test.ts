import { describe, expect, it } from "vitest";
import type { AnalysisOutput } from "@trafego/shared";
import { DEFAULT_MARGINAL_CPA_THRESHOLDS, guardScaleWithWorseningMarginalCpa, marginalCpaRiseByEntity } from "./index.js";
import type { EntitySummary } from "@trafego/shared";

const rec = (over: Partial<AnalysisOutput["recommendations"][number]>): AnalysisOutput["recommendations"][number] => ({
  id: "r1",
  title: "t",
  rationale: "porque sim",
  priority: "high",
  actionType: "increase_budget",
  targetEntity: { level: "campaign", externalId: "C1" },
  budgetChangePct: 20,
  ...over,
});

const output = (recs: AnalysisOutput["recommendations"]): AnalysisOutput => ({
  scorecard: { grade: "B", headline: "h", biggestLeak: "conversao" },
  summary: "s",
  findings: [],
  recommendations: recs,
});

function summary(over: Partial<EntitySummary> & { id: string }): EntitySummary {
  return {
    level: "campaign",
    name: over.id,
    status: "active",
    metrics: { spend: 100, impressions: 5000, clicks: 150, ctr: 2.5, cpc: 0.67, cpm: 20 },
    deltaVsBaseline: {},
    flags: [],
    conversionBasis: "target",
    ...over,
  };
}

describe("marginalCpaRiseByEntity", () => {
  it("calcula % de alta do CPA vs baseline (cpa atual - delta = baseline)", () => {
    // cpa atual 12, delta +4 → baseline 8 → alta de 50%.
    const map = marginalCpaRiseByEntity({
      segments: {
        campaigns: [summary({ id: "C1", metrics: { spend: 100, impressions: 1000, clicks: 50, ctr: 5, cpc: 2, cpm: 100, cpa: 12 }, deltaVsBaseline: { cpa: 4 } })],
        adsets: [],
        ads: [],
      },
    } as never);
    expect(map.get("C1")).toBeCloseTo(50, 5);
  });

  it("sem cpa ou sem delta → undefined (não penaliza por falta de dado)", () => {
    const map = marginalCpaRiseByEntity({
      segments: { campaigns: [summary({ id: "C1", deltaVsBaseline: {} })], adsets: [], ads: [] },
    } as never);
    expect(map.get("C1")).toBeUndefined();
  });
});

describe("guardScaleWithWorseningMarginalCpa", () => {
  it("rebaixa escalar quando o CPA marginal piorou acima do limiar (squad: 'CPA médio mente, marginal conta a verdade')", () => {
    const out = guardScaleWithWorseningMarginalCpa(output([rec({})]), new Map([["C1", 30]]), DEFAULT_MARGINAL_CPA_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("investigate");
    expect(out.recommendations[0]!.rationale).toContain("marginal");
    expect(out.recommendations[0]!.budgetChangePct).toBeNull();
  });

  it("não mexe quando a alta do CPA está abaixo do limiar", () => {
    const out = guardScaleWithWorseningMarginalCpa(output([rec({})]), new Map([["C1", 5]]), DEFAULT_MARGINAL_CPA_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("sem sinal (undefined) → não mexe (não penaliza por falta de dado)", () => {
    const out = guardScaleWithWorseningMarginalCpa(output([rec({})]), new Map([["C1", undefined]]), DEFAULT_MARGINAL_CPA_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("nunca mexe em ações defensivas (pausar/reduzir)", () => {
    const out = guardScaleWithWorseningMarginalCpa(output([rec({ actionType: "pause" })]), new Map([["C1", 90]]), DEFAULT_MARGINAL_CPA_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("pause");
  });
});
