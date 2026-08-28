import { describe, expect, it } from "vitest";
import { copyOf, rankAdsForReuse, type RawAdCandidate } from "./creative-select.js";

const ad = (id: string, over: Partial<RawAdCandidate> = {}): RawAdCandidate => ({ id, effective_status: "ACTIVE", ...over });
const withInsights = (spend: number, results?: { type: string; value: number }[]) => ({
  data: [{ spend: String(spend), actions: (results ?? []).map((r) => ({ action_type: r.type, value: String(r.value) })) }],
});

describe("rankAdsForReuse", () => {
  it("prefere quem tem resultado sobre quem só gastou", () => {
    const spender = ad("big_spend", { insights: withInsights(1000) });
    const converter = ad("has_result", { insights: withInsights(100, [{ type: "purchase", value: 5 }]) });
    const ranked = rankAdsForReuse([spender, converter]);
    expect(ranked[0]!.ad.id).toBe("has_result");
  });

  it("entre os com resultado, menor custo por resultado vence", () => {
    const cheap = ad("cheap", { insights: withInsights(100, [{ type: "purchase", value: 10 }]) }); // CPR 10
    const pricey = ad("pricey", { insights: withInsights(100, [{ type: "purchase", value: 2 }]) }); // CPR 50
    const ranked = rankAdsForReuse([pricey, cheap]);
    expect(ranked.map((r) => r.ad.id)).toEqual(["cheap", "pricey"]);
  });

  it("sem resultados, maior gasto (investimento provado) vence", () => {
    const small = ad("small", { insights: withInsights(50) });
    const large = ad("large", { insights: withInsights(500) });
    expect(rankAdsForReuse([small, large])[0]!.ad.id).toBe("large");
  });

  it("ignora anúncios não-ativos quando há ativos", () => {
    const paused = ad("paused", { effective_status: "PAUSED", insights: withInsights(9999, [{ type: "purchase", value: 99 }]) });
    const active = ad("active", { insights: withInsights(10, [{ type: "purchase", value: 1 }]) });
    const ranked = rankAdsForReuse([paused, active]);
    expect(ranked.every((r) => r.ad.id !== "paused")).toBe(true);
    expect(ranked[0]!.ad.id).toBe("active");
  });

  it("sem nenhum ativo, cai no que houver (cold-start reusa uma mídia real)", () => {
    const paused = ad("only_paused", { effective_status: "PAUSED", insights: withInsights(100) });
    expect(rankAdsForReuse([paused])[0]!.ad.id).toBe("only_paused");
  });

  it("descarta candidatos sem id", () => {
    expect(rankAdsForReuse([{ effective_status: "ACTIVE" }])).toHaveLength(0);
  });

  it("conta múltiplos tipos de resultado (lead + purchase)", () => {
    const a = ad("a", { insights: withInsights(100, [{ type: "lead", value: 4 }, { type: "purchase", value: 1 }]) }); // 5 → CPR 20
    const b = ad("b", { insights: withInsights(100, [{ type: "purchase", value: 2 }]) }); // CPR 50
    expect(rankAdsForReuse([b, a])[0]!.ad.id).toBe("a");
  });
});

describe("copyOf", () => {
  it("extrai de link_data (imagem)", () => {
    const c = copyOf(ad("x", { creative: { object_story_spec: { link_data: { message: "texto", name: "titulo" } } } }));
    expect(c).toEqual({ primaryText: "texto", headline: "titulo" });
  });
  it("extrai de video_data (vídeo)", () => {
    const c = copyOf(ad("x", { creative: { object_story_spec: { video_data: { message: "v", title: "t" } } } }));
    expect(c).toEqual({ primaryText: "v", headline: "t" });
  });
  it("null quando não há copy", () => {
    expect(copyOf(ad("x"))).toBeNull();
  });
});
