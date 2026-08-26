import { describe, expect, it } from "vitest";
import type { AnalysisOutput, EntitySummary } from "@trafego/shared";
import { annotateFreedSpend, computeWasteReport } from "./index.js";

function camp(over: Partial<EntitySummary> & { id: string; spend: number }): EntitySummary {
  const { spend, ...rest } = over;
  return {
    level: "campaign",
    name: over.id,
    status: "active",
    metrics: { spend, impressions: 1000, clicks: 50, ctr: 1, cpc: 1, cpm: 10 },
    deltaVsBaseline: {},
    flags: [],
    conversionBasis: "target",
    ...rest,
  };
}

describe("computeWasteReport", () => {
  it("wastedSpend = só zumbis (R$ + %)", () => {
    const out = computeWasteReport([
      camp({ id: "A", spend: 4500, tier: "winner", metrics: { spend: 4500, impressions: 9e4, clicks: 900, ctr: 1, cpc: 5, cpm: 50, conversions: 300 } }),
      camp({ id: "Z1", spend: 700, tier: "zombie" }),
      camp({ id: "Z2", spend: 500, tier: "zombie" }),
      camp({ id: "B", spend: 800, tier: "performer", metrics: { spend: 800, impressions: 2e4, clicks: 400, ctr: 2, cpc: 2, cpm: 40, conversions: 1100 } }),
    ]);
    expect(out.wastedSpend).toBe(1200);
    expect(out.zombies).toHaveLength(2);
    expect(out.totalSpend).toBe(6500);
    expect(out.wastedPct).toBeCloseTo(18.5, 0);
  });

  it("Pareto por base: aponta má alocação (gasto alto × resultado baixo)", () => {
    const out = computeWasteReport([
      // 45% do gasto, ~11% do resultado → mal alocada
      camp({ id: "A", spend: 4500, metrics: { spend: 4500, impressions: 9e4, clicks: 900, ctr: 1, cpc: 5, cpm: 50, conversions: 300 } }),
      // 8% do gasto, ~40% do resultado
      camp({ id: "B", spend: 800, metrics: { spend: 800, impressions: 2e4, clicks: 400, ctr: 2, cpc: 2, cpm: 40, conversions: 1100 } }),
      camp({ id: "C", spend: 4700, metrics: { spend: 4700, impressions: 5e4, clicks: 500, ctr: 1, cpc: 9, cpm: 90, conversions: 1400 } }),
    ]);
    expect(out.pareto?.basis).toBe("target");
    expect(out.pareto?.items[0]!.id).toBe("C"); // maior gasto primeiro
    const a = out.pareto?.items.find((i) => i.id === "A");
    expect(a?.spendPct).toBeGreaterThan(a!.resultPct!); // gasta mais do que entrega
    expect(out.pareto?.misallocated.map((i) => i.id)).toContain("A");
  });
});

describe("annotateFreedSpend", () => {
  const output = (): AnalysisOutput => ({
    scorecard: { grade: "C", headline: "h", biggestLeak: "conversao" },
    summary: "s",
    findings: [],
    recommendations: [
      { id: "r1", title: "pausar Z", rationale: "zumbi", priority: "high", actionType: "pause", targetEntity: { level: "campaign", externalId: "Z1" }, budgetChangePct: null },
      { id: "r2", title: "escalar B", rationale: "boa", priority: "medium", actionType: "increase_budget", targetEntity: { level: "campaign", externalId: "B" }, budgetChangePct: 20 },
    ],
  });

  it("anexa gasto liberado só às pausas (na moeda da conta)", () => {
    const out = annotateFreedSpend(output(), new Map([["Z1", 700], ["B", 800]]), "USD");
    expect(out.recommendations[0]!.rationale).toContain("libera ~USD 700");
    expect(out.recommendations[1]!.rationale).toBe("boa");
  });
});
