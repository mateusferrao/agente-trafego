import { describe, expect, it } from "vitest";
import { copyOf, creativeFormatOf, isReusableCreative, rankAdsForReuse, selectReuseCreative, type RawAdCandidate } from "./creative-select.js";

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


describe("creativeFormatOf / isReusableCreative", () => {
  it("classifica imagem, vídeo, carrossel, catálogo, outro", () => {
    expect(creativeFormatOf(ad("a", { creative: { object_story_spec: { link_data: { image_hash: "H" } } } }))).toBe("image");
    expect(creativeFormatOf(ad("a", { creative: { object_story_spec: { video_data: { video_id: "V" } } } }))).toBe("video");
    expect(creativeFormatOf(ad("a", { creative: { object_story_spec: { link_data: { child_attachments: [{}, {}] } } } }))).toBe("carousel");
    expect(creativeFormatOf(ad("a", { creative: { object_story_spec: { product_set_id: "PS" } } }))).toBe("catalog");
    expect(creativeFormatOf(ad("a", {}))).toBe("other");
  });
  it("reusável = só imagem/vídeo", () => {
    expect(isReusableCreative(ad("a", { creative: { object_story_spec: { link_data: { image_hash: "H" } } } }))).toBe(true);
    expect(isReusableCreative(ad("a", { creative: { object_story_spec: { video_data: { video_id: "V" } } } }))).toBe(true);
    expect(isReusableCreative(ad("a", { creative: { object_story_spec: { link_data: { child_attachments: [{}] } } } }))).toBe(false);
    expect(isReusableCreative(ad("a", { creative: { object_story_spec: { product_set_id: "PS" } } }))).toBe(false);
  });
});

describe("selectReuseCreative (vencedor não-reusável não zera o pick)", () => {
  it("carrossel é #1 por desempenho → pick cai no melhor IMAGEM/VÍDEO + flag do formato do topo", () => {
    const carousel = ad("carousel", { creative: { object_story_spec: { link_data: { child_attachments: [{}, {}] } } }, insights: withInsights(100, [{ type: "purchase", value: 20 }]) }); // CPR 5, melhor
    const image = ad("img", { creative: { object_story_spec: { link_data: { image_hash: "H" } } }, insights: withInsights(100, [{ type: "purchase", value: 4 }]) }); // CPR 25
    const out = selectReuseCreative([image, carousel]);
    expect(out.best?.ad.id).toBe("img");
    expect(out.topUnsupportedFormat).toBe("carousel");
  });
  it("todos reusáveis → sem flag, best = o melhor", () => {
    const a = ad("a", { creative: { object_story_spec: { link_data: { image_hash: "H" } } }, insights: withInsights(100, [{ type: "purchase", value: 10 }]) });
    const b = ad("b", { creative: { object_story_spec: { link_data: { image_hash: "H2" } } }, insights: withInsights(100, [{ type: "purchase", value: 2 }]) });
    const out = selectReuseCreative([a, b]);
    expect(out.best?.ad.id).toBe("a");
    expect(out.topUnsupportedFormat).toBeNull();
  });
  it("só carrossel → best null + flag (a casca explica o porquê)", () => {
    const out = selectReuseCreative([ad("c", { creative: { object_story_spec: { link_data: { child_attachments: [{}] } } }, insights: withInsights(100) })]);
    expect(out.best).toBeNull();
    expect(out.topUnsupportedFormat).toBe("carousel");
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
