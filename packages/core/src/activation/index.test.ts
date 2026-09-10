import { describe, expect, it } from "vitest";
import type { ActivationTree } from "@trafego/shared";
import { campaignDelivering, pausedDescendants } from "./index.js";

type St = "active" | "paused";
const adset = (id: string, status: St, eff: St = status) => ({ id, name: id, status, effectiveStatus: eff });
const ad = (id: string, adsetId: string, status: St, eff: St = status) => ({ id, name: id, status, effectiveStatus: eff, adsetId });

describe("pausedDescendants (usa o status PRÓPRIO, não o efetivo)", () => {
  it("devolve só os conjuntos e anúncios PAUSADOS no próprio nível (os a religar)", () => {
    const tree: ActivationTree = {
      adsets: [adset("s1", "active"), adset("s2", "paused")],
      ads: [ad("a1", "s1", "active"), ad("a2", "s1", "paused"), ad("a3", "s2", "paused")],
      truncated: false,
    };
    const r = pausedDescendants(tree);
    expect(r.adsets.map((s) => s.id)).toEqual(["s2"]);
    expect(r.ads.map((a) => a.id)).toEqual(["a2", "a3"]);
  });
  it("filho ATIVO no próprio nível mas efetivo pausado (pai pausado) → NÃO religa (own status vence)", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active", "paused")], ads: [ad("a1", "s1", "active", "paused")], truncated: false };
    expect(pausedDescendants(tree)).toEqual({ adsets: [], ads: [] });
  });
});

describe("campaignDelivering (usa o status EFETIVO)", () => {
  it("existe anúncio EFETIVAMENTE ativo → entrega", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [ad("a1", "s1", "active"), ad("a2", "s1", "paused")], truncated: false };
    expect(campaignDelivering(tree)).toEqual({ delivering: true });
  });
  it("anúncio ativo no PRÓPRIO nível mas efetivo pausado (adset pausado) → não entrega", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "paused")], ads: [ad("a1", "s1", "active", "paused")], truncated: false };
    expect(campaignDelivering(tree)).toEqual({ delivering: false, reason: "conjuntos pausados" });
  });
  it("conjunto ativo mas nenhum anúncio ativo → 'anúncios pausados'", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [ad("a1", "s1", "paused")], truncated: false };
    expect(campaignDelivering(tree)).toEqual({ delivering: false, reason: "anúncios pausados" });
  });
  it("sem anúncio nenhum → 'sem anúncio'", () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [], truncated: false };
    expect(campaignDelivering(tree)).toEqual({ delivering: false, reason: "sem anúncio" });
  });
});
