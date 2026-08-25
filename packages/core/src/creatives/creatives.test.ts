import { describe, expect, it } from "vitest";
import { rankAdCreatives, type RankableCreative } from "./index.js";

const c = (p: Partial<RankableCreative> & { id: string }): RankableCreative & { id: string } => ({
  tier: null,
  roas: null,
  cpa: null,
  spend: null,
  ...p,
});

describe("rankAdCreatives", () => {
  it("ordena por tier (winner→zombie), sem-tier por último", () => {
    const out = rankAdCreatives([
      c({ id: "z", tier: "zombie" }),
      c({ id: "none" }),
      c({ id: "w", tier: "winner" }),
      c({ id: "p", tier: "performer" }),
    ]);
    expect(out.map((r) => (r as { id: string }).id)).toEqual(["w", "p", "z", "none"]);
  });

  it("desempata por ROAS desc dentro do mesmo tier", () => {
    const out = rankAdCreatives([
      c({ id: "lo", tier: "winner", roas: 2 }),
      c({ id: "hi", tier: "winner", roas: 5 }),
    ]);
    expect((out[0] as { id: string }).id).toBe("hi");
  });

  it("sem ROAS, desempata por CPA asc (menor é melhor)", () => {
    const out = rankAdCreatives([
      c({ id: "caro", tier: "performer", cpa: 80 }),
      c({ id: "barato", tier: "performer", cpa: 30 }),
    ]);
    expect((out[0] as { id: string }).id).toBe("barato");
  });

  it("sem tier/ROAS/CPA, desempata por gasto desc", () => {
    const out = rankAdCreatives([c({ id: "peq", spend: 10 }), c({ id: "gde", spend: 100 })]);
    expect((out[0] as { id: string }).id).toBe("gde");
  });

  it("não muta a entrada", () => {
    const input = [c({ id: "a", tier: "zombie" }), c({ id: "b", tier: "winner" })];
    const snapshot = input.map((r) => (r as { id: string }).id);
    rankAdCreatives(input);
    expect(input.map((r) => (r as { id: string }).id)).toEqual(snapshot);
  });
});
