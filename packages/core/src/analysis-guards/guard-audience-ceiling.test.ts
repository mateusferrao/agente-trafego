import { describe, expect, it } from "vitest";
import type { AnalysisOutput } from "@trafego/shared";
import { DEFAULT_AUDIENCE_CEILING_THRESHOLDS, guardAudienceScaleCeiling } from "./index.js";

const rec = (over: Partial<AnalysisOutput["recommendations"][number]>): AnalysisOutput["recommendations"][number] => ({
  id: "r1",
  title: "t",
  rationale: "porque sim",
  priority: "high",
  actionType: "increase_budget",
  targetEntity: { level: "adset", externalId: "AS1" },
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

describe("guardAudienceScaleCeiling (Fase 4 — teto de escala por audiência, reativo)", () => {
  it("público perto do teto (impressões/mês >= 80% de MAU×frequencyCap) → rebaixa pra investigate", () => {
    const headroom = new Map([["AS1", { monthlyReach: 10000, currentMonthlyImpressions: 30000, frequencyCap: 3 }]]); // cap=30000, ratio=1.0
    const out = guardAudienceScaleCeiling(output([rec({})]), headroom, DEFAULT_AUDIENCE_CEILING_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("investigate");
    expect(out.recommendations[0]!.budgetChangePct).toBeNull();
    expect(out.recommendations[0]!.rationale).toContain("[guard]");
    expect(out.recommendations[0]!.title).toBe("Investigar: t");
  });

  it("público com folga (ratio abaixo do limiar) → passa direto", () => {
    const headroom = new Map([["AS1", { monthlyReach: 100000, currentMonthlyImpressions: 30000, frequencyCap: 3 }]]); // cap=300000, ratio=0.1
    const out = guardAudienceScaleCeiling(output([rec({})]), headroom, DEFAULT_AUDIENCE_CEILING_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("sem estimativa pronta (monthlyReach ausente) → passa direto (honesto: sem dado, não assume saturado)", () => {
    const headroom = new Map([["AS1", { currentMonthlyImpressions: 30000, frequencyCap: 3 }]]);
    const out = guardAudienceScaleCeiling(output([rec({})]), headroom, DEFAULT_AUDIENCE_CEILING_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("entidade sem headroom resolvido (não era alvo de escala neste run) → passa direto", () => {
    const out = guardAudienceScaleCeiling(output([rec({})]), new Map(), DEFAULT_AUDIENCE_CEILING_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("ação que NÃO é escala (ex: pause) → nunca tocada, mesmo com público saturado", () => {
    const headroom = new Map([["AS1", { monthlyReach: 10000, currentMonthlyImpressions: 30000, frequencyCap: 3 }]]);
    const out = guardAudienceScaleCeiling(output([rec({ actionType: "pause" })]), headroom, DEFAULT_AUDIENCE_CEILING_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("pause");
  });

  it("resume (reativar) também é ação de escala → rebaixa igual increase_budget", () => {
    const headroom = new Map([["AS1", { monthlyReach: 10000, currentMonthlyImpressions: 30000, frequencyCap: 3 }]]);
    const out = guardAudienceScaleCeiling(output([rec({ actionType: "resume" })]), headroom, DEFAULT_AUDIENCE_CEILING_THRESHOLDS);
    expect(out.recommendations[0]!.actionType).toBe("investigate");
  });
});
