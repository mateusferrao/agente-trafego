import { describe, expect, it } from "vitest";
import { AdsPlatformError } from "@trafego/shared/ports";
import type { BatchSubResponse } from "./client.js";
import {
  normalizeDupTree,
  buildCopyBatch,
  extractCopiedCampaignId,
  classifyCopyResults,
  buildReconstructBatch,
  collectReconstructIds,
  type DupTree,
} from "./creation.js";

const ok = (body: Record<string, unknown>): BatchSubResponse => ({ code: 200, body: JSON.stringify(body) });
const notDup = (subcode: number): BatchSubResponse => ({ code: 400, body: JSON.stringify({ error: { code: 100, error_subcode: subcode, error_user_msg: "config descontinuada" } }) });
const hardErr = (): BatchSubResponse => ({ code: 400, body: JSON.stringify({ error: { code: 200, message: "boom" } }) });

const TREE: DupTree = {
  adsets: [
    { id: "AS0", fields: { name: "c0", optimization_goal: "CONVERSATIONS", billing_event: "IMPRESSIONS" }, ads: [{ id: "AD0", name: "a0", creativeId: "CRE0" }] },
    { id: "AS1", fields: { name: "c1", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS" }, ads: [{ id: "AD1", name: "a1", creativeId: "CRE1" }] },
  ],
};

describe("normalizeDupTree", () => {
  it("achata a árvore crua aninhada em conjuntos + anúncios (creativeId)", () => {
    const t = normalizeDupTree({
      adsets: { data: [{ id: "AS0", name: "x", optimization_goal: "CONVERSATIONS", ads: { data: [{ id: "AD0", name: "a0", creative: { id: "CRE0" } }, { id: "no-cre" }] } }] },
    });
    expect(t.adsets).toHaveLength(1);
    expect(t.adsets[0]!.ads).toEqual([{ id: "AD0", name: "a0", creativeId: "CRE0" }, { id: "no-cre", name: null, creativeId: null }]);
    expect(t.adsets[0]!.fields.optimization_goal).toBe("CONVERSATIONS");
  });
});

describe("buildCopyBatch", () => {
  it("casca (name=c, omit=false, rename) → conjuntos (ref campanha) → anúncios (ref conjunto), na ordem", () => {
    const { requests, slots } = buildCopyBatch("C1", TREE, "paused", " — escala");
    expect(slots).toEqual([{ kind: "campaign" }, { kind: "adset", i: 0 }, { kind: "ad", i: 0, j: 0 }, { kind: "adset", i: 1 }, { kind: "ad", i: 1, j: 0 }]);
    expect(requests[0]).toMatchObject({ relativeUrl: "C1/copies", name: "c", omitResponseOnSuccess: false });
    expect(requests[0]!.body!["rename_options"]).toContain("escala");
    expect(requests[1]).toMatchObject({ relativeUrl: "AS0/copies", name: "as0", omitResponseOnSuccess: false });
    expect(requests[1]!.body!["campaign_id"]).toBe("{result=c:$.copied_campaign_id}");
    expect(requests[2]!.body!["adset_id"]).toBe("{result=as0:$.copied_adset_id}");
  });
});

describe("extractCopiedCampaignId", () => {
  it("sucesso → id da campanha copiada", () => {
    expect(extractCopiedCampaignId([ok({ copied_campaign_id: "C_NEW" })])).toBe("C_NEW");
  });
  it("falha da casca → lança (nada criado, sem revert)", () => {
    expect(() => extractCopiedCampaignId([hardErr()])).toThrow();
  });
});

describe("classifyCopyResults", () => {
  const { slots } = buildCopyBatch("C1", TREE, "paused");

  it("tudo copiado → sem reconstrução", () => {
    const results = [ok({ copied_campaign_id: "C_NEW" }), ok({ copied_adset_id: "AS0_N" }), ok({ copied_ad_id: "AD0_N" }), ok({ copied_adset_id: "AS1_N" }), ok({ copied_ad_id: "AD1_N" })];
    const cls = classifyCopyResults(TREE, slots, results);
    expect(cls.copiedAdsetIds).toEqual(["AS0_N", "AS1_N"]);
    expect(cls.copiedAdIds).toEqual(["AD0_N", "AD1_N"]);
    expect(cls.reconstructAdsets).toEqual([]);
    expect(cls.adsToReconstruct).toEqual([]);
  });

  it("conjunto com atribuição (1885423) → reconstrói ele; seus ads (dependência) são ignorados aqui", () => {
    const results = [ok({ copied_campaign_id: "C_NEW" }), notDup(1885423), hardErr() /* ad de AS0 falhou por dependência — ignorado */, ok({ copied_adset_id: "AS1_N" }), ok({ copied_ad_id: "AD1_N" })];
    const cls = classifyCopyResults(TREE, slots, results);
    expect(cls.reconstructAdsets).toEqual([0]);
    expect(cls.copiedAdsetIds).toEqual([null, "AS1_N"]);
    expect(cls.adsToReconstruct).toEqual([]);
  });

  it("anúncio com criativo legado (3858504) sob conjunto copiado → reconstrói só o ad", () => {
    const results = [ok({ copied_campaign_id: "C_NEW" }), ok({ copied_adset_id: "AS0_N" }), notDup(3858504), ok({ copied_adset_id: "AS1_N" }), ok({ copied_ad_id: "AD1_N" })];
    const cls = classifyCopyResults(TREE, slots, results);
    expect(cls.reconstructAdsets).toEqual([]);
    expect(cls.adsToReconstruct).toEqual([{ i: 0, j: 0 }]);
    expect(cls.copiedAdIds).toEqual(["AD1_N"]);
  });

  it("erro DURO (não-not_duplicable) num conjunto → lança (a casca reverte)", () => {
    const results = [ok({ copied_campaign_id: "C_NEW" }), hardErr(), ok({}), ok({}), ok({})];
    expect(() => classifyCopyResults(TREE, slots, results)).toThrow();
  });
});

describe("buildReconstructBatch", () => {
  it("conjunto recusado → mirror-create (ref campanha real) + seus anúncios (ref conjunto novo, creative_id)", () => {
    const cls = { copiedAdsetIds: [null, "AS1_N"], copiedAdIds: [], adsToReconstruct: [], reconstructAdsets: [0] };
    const { requests, slots } = buildReconstructBatch("act_9", "C_NEW", TREE, cls, "paused");
    expect(slots).toEqual([{ kind: "adset", i: 0 }, { kind: "ad", i: 0, j: 0 }]);
    expect(requests[0]).toMatchObject({ relativeUrl: "act_9/adsets", name: "ras0", omitResponseOnSuccess: false });
    expect(requests[0]!.body!["campaign_id"]).toBe("C_NEW");
    expect(requests[0]!.body!["optimization_goal"]).toBe("CONVERSATIONS");
    expect(requests[0]!.body).not.toHaveProperty("attribution_spec");
    expect(requests[1]).toMatchObject({ relativeUrl: "act_9/ads" });
    expect(requests[1]!.body!["adset_id"]).toBe("{result=ras0:$.id}");
    expect(requests[1]!.body!["creative"]).toBe(JSON.stringify({ creative_id: "CRE0" }));
  });

  it("ad solto recusado sob conjunto copiado → create referenciando o conjunto copiado (id real)", () => {
    const cls = { copiedAdsetIds: ["AS0_N", "AS1_N"], copiedAdIds: [], adsToReconstruct: [{ i: 0, j: 0 }], reconstructAdsets: [] };
    const { requests, slots } = buildReconstructBatch("act_9", "C_NEW", TREE, cls, "paused");
    expect(slots).toEqual([{ kind: "ad", i: 0, j: 0 }]);
    expect(requests[0]!.body!["adset_id"]).toBe("AS0_N");
    expect(requests[0]!.body!["creative"]).toBe(JSON.stringify({ creative_id: "CRE0" }));
  });

  it("anúncio-fonte sem criativo → not_duplicable (a rede reverte)", () => {
    const noCre: DupTree = { adsets: [{ id: "AS0", fields: { name: "c" }, ads: [{ id: "AD0", name: "a", creativeId: null }] }] };
    const cls = { copiedAdsetIds: [null], copiedAdIds: [], adsToReconstruct: [], reconstructAdsets: [0] };
    expect(() => buildReconstructBatch("act_9", "C_NEW", noCre, cls, "paused")).toThrow(AdsPlatformError);
  });
});

describe("collectReconstructIds", () => {
  it("sucesso → separa ids de conjunto e anúncio", () => {
    const slots = [{ kind: "adset" as const, i: 0 }, { kind: "ad" as const, i: 0, j: 0 }];
    const res = collectReconstructIds(slots, [ok({ id: "AS0_R" }), ok({ id: "AD0_R" })]);
    expect(res).toEqual({ adsetIds: ["AS0_R"], adIds: ["AD0_R"] });
  });
  it("qualquer erro na reconstrução → lança (a casca reverte)", () => {
    const slots = [{ kind: "adset" as const, i: 0 }];
    expect(() => collectReconstructIds(slots, [hardErr()])).toThrow();
  });
});
