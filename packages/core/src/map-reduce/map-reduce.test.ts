import { describe, expect, it } from "vitest";
import type { EntitySummary } from "@trafego/shared";
import type { UnitAnalysis } from "@trafego/shared";
import { isMateriallyChanged, mergeUnitAnalyses, selectCreatives, selectUnitsToAnalyze, type LastUnit } from "./index.js";

function ad(id: string, spend: number, cpa?: number, flags: string[] = []): EntitySummary {
  return {
    id,
    level: "ad",
    name: id,
    status: "active",
    metrics: { spend, impressions: 1000, clicks: 50, ctr: 5, cpc: 1, cpm: 10, ...(cpa !== undefined ? { cpa } : {}) },
    deltaVsBaseline: {},
    flags,
  };
}

describe("isMateriallyChanged", () => {
  it("nova unidade (sem última) → mudou", () => {
    expect(isMateriallyChanged(ad("a", 100, 50), undefined, 15)).toBe(true);
  });
  it("métrica estável dentro do limiar → não mudou", () => {
    const last: LastUnit = { metrics: { spend: 100, cpa: 50, ctr: 5 }, flags: [] };
    expect(isMateriallyChanged(ad("a", 105, 52), last, 15)).toBe(false);
  });
  it("métrica salta acima do limiar → mudou", () => {
    const last: LastUnit = { metrics: { spend: 100, cpa: 50, ctr: 5 }, flags: [] };
    expect(isMateriallyChanged(ad("a", 100, 80), last, 15)).toBe(true);
  });
  it("mudança de flag → mudou", () => {
    const last: LastUnit = { metrics: { spend: 100, cpa: 50, ctr: 5 }, flags: [] };
    expect(isMateriallyChanged(ad("a", 100, 50, ["cpa_acima_da_meta"]), last, 15)).toBe(true);
  });
});

describe("selectUnitsToAnalyze", () => {
  const units = [ad("a", 100, 50), ad("b", 200, 40), ad("c", 50, 100)];

  it("full_every_run → analisa tudo", () => {
    const sel = selectUnitsToAnalyze(units, new Map(), { policy: "full_every_run", materialChangePct: 15, isDeepRun: false });
    expect(sel.toAnalyze).toHaveLength(3);
    expect(sel.toInherit).toHaveLength(0);
  });

  it("deep run (incremental) → analisa tudo", () => {
    const sel = selectUnitsToAnalyze(units, new Map(), { policy: "deep_periodic_incremental", materialChangePct: 15, isDeepRun: true });
    expect(sel.toAnalyze).toHaveLength(3);
  });

  it("dia comum incremental → só as mudadas; resto herda", () => {
    const last = new Map<string, LastUnit>([
      ["a", { metrics: { spend: 100, cpa: 50, ctr: 5 }, flags: [] }], // estável
      ["b", { metrics: { spend: 100, cpa: 40, ctr: 5 }, flags: [] }], // spend saltou 100→200
      // c: sem última → nova → analisa
    ]);
    const sel = selectUnitsToAnalyze(units, last, { policy: "deep_periodic_incremental", materialChangePct: 15, isDeepRun: false });
    expect(sel.toAnalyze.map((u) => u.id).sort()).toEqual(["b", "c"]);
    expect(sel.toInherit.map((u) => u.id)).toEqual(["a"]);
  });

  it("budget_scaled → top por gasto até o teto; resto herda se tiver histórico", () => {
    const last = new Map<string, LastUnit>([["a", { metrics: { spend: 100 }, flags: [] }]]);
    const sel = selectUnitsToAnalyze(units, last, { policy: "budget_scaled", materialChangePct: 15, isDeepRun: false, maxUnitsThisRun: 1 });
    expect(sel.toAnalyze.map((u) => u.id)).toEqual(["b"]); // maior gasto
    expect(sel.toInherit.map((u) => u.id)).toEqual(["a"]); // tem histórico
    expect(sel.dropped.map((u) => u.id)).toEqual(["c"]); // sem histórico + fora do teto
  });

  it("budget_scaled respeita o teto MESMO em deep/on-demand (não estoura o orçamento)", () => {
    const sel = selectUnitsToAnalyze(units, new Map(), {
      policy: "budget_scaled",
      materialChangePct: 15,
      isDeepRun: true, // deep não fura o teto do budget_scaled
      maxUnitsThisRun: 1,
    });
    expect(sel.toAnalyze.map((u) => u.id)).toEqual(["b"]); // só o de maior gasto
    expect(sel.toAnalyze).toHaveLength(1);
  });
});

describe("selectCreatives", () => {
  it("junta criativos das unidades analisadas até o teto", () => {
    const byAd = new Map([
      ["a", [{ id: "cr1", adId: "a" }]],
      ["b", [{ id: "cr2", adId: "b" }, { id: "cr3", adId: "b" }]],
    ]) as ReadonlyMap<string, { id: string; adId: string }[]>;
    const out = selectCreatives(["a", "b"], byAd as never, 2);
    expect(out.map((c) => c.id)).toEqual(["cr1", "cr2"]); // cap = 2
  });
});

describe("mergeUnitAnalyses", () => {
  it("deduplica por título e deriva a nota pela pior severidade", () => {
    const units: UnitAnalysis[] = [
      { summary: "u1", flags: [], findings: [{ id: "f1", title: "CPA alto", detail: "x", severity: "critical", metricRefs: [], caveat: null }], recommendations: [{ id: "r1", title: "Pausar", rationale: "x", priority: "high", actionType: "pause", targetEntity: null, budgetChangePct: null, expectedImpact: null, whatToMonitor: null, findingRefs: null }] },
      { summary: "u2", flags: [], findings: [{ id: "f2", title: "CPA alto", detail: "y", severity: "warning", metricRefs: [], caveat: null }], recommendations: [{ id: "r2", title: "Pausar", rationale: "y", priority: "high", actionType: "pause", targetEntity: null, budgetChangePct: null, expectedImpact: null, whatToMonitor: null, findingRefs: null }] },
    ];
    const out = mergeUnitAnalyses(units);
    expect(out.findings).toHaveLength(1); // dedupe por título
    expect(out.recommendations).toHaveLength(1);
    expect(out.scorecard.grade).toBe("D"); // tem critical
  });
});
