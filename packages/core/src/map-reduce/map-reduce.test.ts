import { describe, expect, it } from "vitest";
import type { CampaignAdsetGroup, CampaignUnit, EntitySummary } from "@trafego/shared";
import type { UnitAnalysis } from "@trafego/shared";
import { deriveAdsetUnits, isMateriallyChanged, mergeUnitAnalyses, selectCreatives, selectUnitsToAnalyze, type LastUnit } from "./index.js";

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

describe("deriveAdsetUnits (S8b — tier/diagnóstico por-adset em ABO multi-adset, SEM call de LLM extra)", () => {
  function adsetGroup(id: string, budget?: number): CampaignAdsetGroup {
    return {
      adset: { ...ad(id, 100), level: "adset", ...(budget !== undefined ? { budget: { dailyMajor: budget } } : {}) },
      notableAds: [],
      tail: { count: 0, spend: 0, allWithinTarget: true },
    };
  }

  it("campanha CBO (budget próprio) → nunca deriva (mesmo com 2+ adsets)", () => {
    const unit: CampaignUnit = {
      campaign: { ...ad("c1", 500), level: "campaign", budget: { dailyMajor: 100 } },
      adsets: [adsetGroup("as1", 50), adsetGroup("as2", 50)],
    };
    const analysis: UnitAnalysis = { summary: "s", findings: [], recommendations: [], flags: [] };
    expect(deriveAdsetUnits(unit, analysis)).toEqual([]);
  });

  it("campanha ABO com só 1 adset ativo → não deriva (não é multi-adset)", () => {
    const unit: CampaignUnit = {
      campaign: { ...ad("c1", 500), level: "campaign" },
      adsets: [adsetGroup("as1", 500)],
    };
    const analysis: UnitAnalysis = { summary: "s", findings: [], recommendations: [], flags: [] };
    expect(deriveAdsetUnits(unit, analysis)).toEqual([]);
  });

  it("ABO com 2+ adsets ativos → 1 entrada por adset, recomendações/findings FILTRADOS por targetEntity (zero LLM extra)", () => {
    const unit: CampaignUnit = {
      campaign: { ...ad("c1", 500), level: "campaign" },
      adsets: [adsetGroup("as1", 300), adsetGroup("as2", 200)],
    };
    const analysis: UnitAnalysis = {
      summary: "s",
      findings: [
        { id: "f1", title: "CPA alto no as1", detail: "x", severity: "warning", metricRefs: [], caveat: null },
        { id: "f2", title: "irrelevante", detail: "y", severity: "info", metricRefs: [], caveat: null },
      ],
      recommendations: [
        {
          id: "r1", title: "Pausar as1", rationale: "x", priority: "high", actionType: "pause",
          targetEntity: { level: "adset", externalId: "as1" }, budgetChangePct: null,
          expectedImpact: null, whatToMonitor: null, findingRefs: ["f1"],
        },
        {
          id: "r2", title: "Recomendação de campanha", rationale: "y", priority: "low", actionType: "keep",
          targetEntity: null, budgetChangePct: null, expectedImpact: null, whatToMonitor: null, findingRefs: null,
        },
      ],
      flags: [],
    };
    const out = deriveAdsetUnits(unit, analysis);
    expect(out).toHaveLength(2);
    const as1 = out.find((o) => o.adset.id === "as1")!;
    expect(as1.unit.recommendations.map((r) => r.id)).toEqual(["r1"]);
    expect(as1.unit.findings.map((f) => f.id)).toEqual(["f1"]); // só o referenciado por r1.findingRefs
    const as2 = out.find((o) => o.adset.id === "as2")!;
    expect(as2.unit.recommendations).toEqual([]); // nenhuma recomendação mira as2 especificamente
    expect(as2.unit.findings).toEqual([]);
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
