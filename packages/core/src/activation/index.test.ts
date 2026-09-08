import { describe, expect, it } from "vitest";
import type { ActivationTree } from "@trafego/shared";
import { campaignDelivering, pausedDescendants } from "./index.js";

const adset = (id: string, status: "active" | "paused") => ({ id, name: id, status });
const ad = (id: string, adsetId: string, status: "active" | "paused") => ({ id, name: id, status, adsetId });

describe("pausedDescendants", () => {
  it("devolve só os conjuntos e anúncios PAUSADOS (os a religar)", () => {
    const tree: ActivationTree = {
      adsets: [adset("s1", "active"), adset("s2", "paused")],
      ads: [ad("a1", "s1", "active"), ad("a2", "s1", "paused"), ad("a3", "s2", "paused")],
    };
    const r = pausedDescendants(tree);
    expect(r.adsets.map((s) => s.id)).toEqual(["s2"]);
    expect(r.ads.map((a) => a.id)).toEqual(["a2", "a3"]);
  });
  it("nada pausado → listas vazias (nada a religar)", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [ad("a1", "s1", "active")] };
    expect(pausedDescendants(tree)).toEqual({ adsets: [], ads: [] });
  });
});

describe("campaignDelivering", () => {
  it("existe anúncio ativo → entrega (a cadeia toda está ativa)", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [ad("a1", "s1", "active"), ad("a2", "s1", "paused")] };
    expect(campaignDelivering(tree)).toEqual({ delivering: true });
  });
  it("conjunto ativo mas nenhum anúncio ativo → 'anúncios pausados'", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [ad("a1", "s1", "paused")] };
    expect(campaignDelivering(tree)).toEqual({ delivering: false, reason: "anúncios pausados" });
  });
  it("nenhum conjunto ativo → 'conjuntos pausados'", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "paused")], ads: [ad("a1", "s1", "paused")] };
    expect(campaignDelivering(tree)).toEqual({ delivering: false, reason: "conjuntos pausados" });
  });
  it("sem anúncio nenhum → 'sem anúncio'", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [] };
    expect(campaignDelivering(tree)).toEqual({ delivering: false, reason: "sem anúncio" });
  });
});
