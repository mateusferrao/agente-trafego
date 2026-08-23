import { describe, expect, it } from "vitest";
import { type SignalComparison, detectMaterialChange } from "./index.js";

const REF = { level: "campaign", id: "c-1", name: "Campanha 1" } as const;

function cmp(current: SignalComparison["current"], baseline: SignalComparison["baseline"]): SignalComparison {
  return { entityRef: REF, current, baseline };
}

describe("detectMaterialChange", () => {
  it("queda material de resultado dispara drop", () => {
    const r = detectMaterialChange([cmp({ results: 5 }, { results: 10 })], "normal");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ metric: "results", direction: "drop", magnitudePct: 50 });
  });

  it("queda pequena (abaixo do limiar) não dispara", () => {
    expect(detectMaterialChange([cmp({ results: 8 }, { results: 10 })], "normal")).toEqual([]);
  });

  it("baseline de volume baixo não dispara mesmo com queda grande (anti-ruído)", () => {
    // baseline 2 < minBaselineResults(3) em normal
    expect(detectMaterialChange([cmp({ results: 0 }, { results: 2 })], "normal")).toEqual([]);
  });

  it("gasto disparando dispara spike", () => {
    const r = detectMaterialChange([cmp({ spend: 200 }, { spend: 100 })], "normal");
    expect(r[0]).toMatchObject({ metric: "spend", direction: "spike", magnitudePct: 100 });
  });

  it("gasto zerado (parou de rodar) dispara zeroed", () => {
    const r = detectMaterialChange([cmp({ spend: 0 }, { spend: 100 })], "normal");
    expect(r[0]).toMatchObject({ metric: "spend", direction: "zeroed" });
  });

  it("gasto de baseline ínfimo não dispara (anti-ruído)", () => {
    expect(detectMaterialChange([cmp({ spend: 0 }, { spend: 2 })], "normal")).toEqual([]);
  });

  it("CPA estourando dispara spike quando há volume", () => {
    const r = detectMaterialChange([cmp({ cpa: 90, results: 5 }, { cpa: 50, results: 10 })], "normal");
    expect(r.some((f) => f.metric === "cpa" && f.direction === "spike")).toBe(true);
  });

  it("sensibilidade alta pega o que a normal deixa passar", () => {
    const c = cmp({ results: 65 }, { results: 100 }); // 35% de queda
    expect(detectMaterialChange([c], "normal")).toEqual([]); // limiar 40
    expect(detectMaterialChange([c], "high")).toHaveLength(1); // limiar 30
  });

  it("entidade estável → nenhum sinal", () => {
    expect(detectMaterialChange([cmp({ results: 10, spend: 100, cpa: 50 }, { results: 10, spend: 100, cpa: 50 })], "normal")).toEqual([]);
  });

  it("uma entidade pode acumular sinais (queda de resultado + CPA estourando)", () => {
    const r = detectMaterialChange([cmp({ results: 4, cpa: 120 }, { results: 10, cpa: 50 })], "normal");
    expect(r.map((f) => f.metric).sort()).toEqual(["cpa", "results"]);
  });
});
