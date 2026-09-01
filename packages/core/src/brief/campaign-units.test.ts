import { describe, expect, it } from "vitest";
import type { AdEntity, CampaignUnit, CreativeVisionResult, EntitySummary, InsightMetrics } from "@trafego/shared";
import { attachCreativeWeaknessSignals, buildCampaignUnits, computeDeactivatedCampaignIds } from "./campaign-units.js";

function metrics(spend: number): InsightMetrics {
  return { spend, impressions: 1000, clicks: 50, ctr: 5, cpc: 1, cpm: 1 };
}

function summary(
  id: string,
  level: EntitySummary["level"],
  spend: number,
  flags: string[] = [],
  status: EntitySummary["status"] = "active",
): EntitySummary {
  return { id, level, name: id, status, metrics: metrics(spend), deltaVsBaseline: {}, flags };
}

function ent(id: string, level: AdEntity["level"], extra: Partial<AdEntity> = {}): AdEntity {
  return { id, level, name: id, status: "active", ...extra };
}

describe("buildCampaignUnits", () => {
  it("curadoria: campanha ativa vira árvore adsets + notáveis (flagado + maior gasto) + cauda", () => {
    const campaigns = [summary("C1", "campaign", 165), summary("C2", "campaign", 200, [], "paused")];
    const adsets = [summary("AS1", "adset", 160), summary("AS2", "adset", 5)];
    const ads = [
      summary("AD1", "ad", 100, ["cpa_acima_da_meta"]), // flagado → priorizado
      summary("AD2", "ad", 60),
      summary("AD3", "ad", 5),
    ];
    const entityById = new Map<string, AdEntity>([
      ["C1", ent("C1", "campaign")],
      ["C2", ent("C2", "campaign")],
      ["AS1", ent("AS1", "adset", { campaignId: "C1" })],
      ["AS2", ent("AS2", "adset", { campaignId: "C1" })],
      ["AD1", ent("AD1", "ad", { campaignId: "C1", adsetId: "AS1" })],
      ["AD2", ent("AD2", "ad", { campaignId: "C1", adsetId: "AS1" })],
      ["AD3", ent("AD3", "ad", { campaignId: "C1", adsetId: "AS2" })],
    ]);

    const units = buildCampaignUnits({ campaigns, adsets, ads, entityById, notableAdsPerCampaign: 2 });

    // C2 pausada → fora
    expect(units).toHaveLength(1);
    expect(units[0]!.campaign.id).toBe("C1");
    expect(units[0]!.adsets).toHaveLength(2);

    // teto 2: flagado AD1 (priorizado) + maior gasto do resto (AD2). AD3 → cauda.
    const as1 = units[0]!.adsets.find((g) => g.adset.id === "AS1")!;
    expect(as1.notableAds.map((a) => a.id).sort()).toEqual(["AD1", "AD2"]);
    expect(as1.tail.count).toBe(0);

    const as2 = units[0]!.adsets.find((g) => g.adset.id === "AS2")!;
    expect(as2.notableAds).toHaveLength(0);
    expect(as2.tail).toMatchObject({ count: 1, spend: 5, allWithinTarget: true });
  });

  it("teto duro: flagado excedente cai na cauda → allWithinTarget false", () => {
    const campaigns = [summary("C1", "campaign", 190)];
    const adsets = [summary("AS1", "adset", 190)];
    const ads = [
      summary("AD1", "ad", 100, ["cpa_acima_da_meta"]), // flagado, maior gasto → notável
      summary("AD2", "ad", 80, ["cpa_acima_da_meta"]), // flagado, mas excede o teto → cauda
      summary("AD3", "ad", 10),
    ];
    const entityById = new Map<string, AdEntity>([
      ["C1", ent("C1", "campaign")],
      ["AS1", ent("AS1", "adset", { campaignId: "C1" })],
      ["AD1", ent("AD1", "ad", { campaignId: "C1", adsetId: "AS1" })],
      ["AD2", ent("AD2", "ad", { campaignId: "C1", adsetId: "AS1" })],
      ["AD3", ent("AD3", "ad", { campaignId: "C1", adsetId: "AS1" })],
    ]);
    // teto=1 → só AD1 (flagado + maior gasto). AD2 (flagado) e AD3 → cauda: contém flagado.
    const units = buildCampaignUnits({ campaigns, adsets, ads, entityById, notableAdsPerCampaign: 1 });
    const as1 = units[0]!.adsets[0]!;
    expect(as1.notableAds.map((a) => a.id)).toEqual(["AD1"]);
    expect(as1.tail).toMatchObject({ count: 2, allWithinTarget: false });
  });

  it("não desperdiça slot de notável com ad órfão (adset pausado/fora da árvore)", () => {
    const campaigns = [summary("C1", "campaign", 100)];
    const adsets = [summary("AS1", "adset", 60)]; // AS2 ausente/pausado → não entra
    const ads = [
      summary("ADX", "ad", 100), // maior gasto, mas adset AS2 fora da árvore
      summary("AD1", "ad", 60),
    ];
    const entityById = new Map<string, AdEntity>([
      ["C1", ent("C1", "campaign")],
      ["AS1", ent("AS1", "adset", { campaignId: "C1" })],
      ["ADX", ent("ADX", "ad", { campaignId: "C1", adsetId: "AS2" })],
      ["AD1", ent("AD1", "ad", { campaignId: "C1", adsetId: "AS1" })],
    ]);
    // teto=1: ADX (maior gasto) é órfão (AS2 fora) → não conta slot; AD1 vira o notável.
    const units = buildCampaignUnits({ campaigns, adsets, ads, entityById, notableAdsPerCampaign: 1 });
    const as1 = units[0]!.adsets[0]!;
    expect(as1.notableAds.map((a) => a.id)).toEqual(["AD1"]);
  });

  it("campanha silenciada → não vira unidade", () => {
    const campaigns = [summary("C1", "campaign", 100)];
    const units = buildCampaignUnits({
      campaigns,
      adsets: [],
      ads: [],
      entityById: new Map([["C1", ent("C1", "campaign")]]),
      notableAdsPerCampaign: 5,
      mutedCampaignIds: new Set(["C1"]),
    });
    expect(units).toHaveLength(0);
  });

  it("campanha ativa sem adsets → unidade só com a campanha", () => {
    const units = buildCampaignUnits({
      campaigns: [summary("C1", "campaign", 100)],
      adsets: [],
      ads: [],
      entityById: new Map([["C1", ent("C1", "campaign")]]),
      notableAdsPerCampaign: 5,
    });
    expect(units).toHaveLength(1);
    expect(units[0]!.adsets).toHaveLength(0);
  });
});

describe("attachCreativeWeaknessSignals (S4b)", () => {
  function unitWithNotableAd(adId: string, extra: Partial<EntitySummary> = {}): CampaignUnit {
    return {
      campaign: summary("C1", "campaign", 100),
      adsets: [{ adset: summary("AS1", "adset", 100), notableAds: [{ ...summary(adId, "ad", 100), ...extra }], tail: { count: 0, spend: 0, allWithinTarget: true } }],
    };
  }
  function vision(overrides: Partial<CreativeVisionResult> = {}): CreativeVisionResult {
    return { summary: "s", strengths: [], weaknesses: [], ...overrides };
  }

  it("prova fraca + baixa persuasão → adiciona weak_creative ao healthSignals do anúncio notável", () => {
    const unit = unitWithNotableAd("AD1");
    const visionByAdId = new Map([["AD1", [vision({ proofStrength: "weak", persuasionSignals: 1 })]]]);
    const out = attachCreativeWeaknessSignals(unit, visionByAdId);
    expect(out.adsets[0]!.notableAds[0]!.healthSignals).toEqual(["weak_creative"]);
  });

  it("preserva healthSignals já existentes (dedup, não substitui)", () => {
    const unit = unitWithNotableAd("AD1", { healthSignals: ["creative_fatigue"] });
    const visionByAdId = new Map([["AD1", [vision({ proofStrength: "weak", persuasionSignals: 1 })]]]);
    const out = attachCreativeWeaknessSignals(unit, visionByAdId);
    expect(out.adsets[0]!.notableAds[0]!.healthSignals).toEqual(["creative_fatigue", "weak_creative"]);
  });

  it("visão forte → não adiciona nada, healthSignals ausente continua ausente", () => {
    const unit = unitWithNotableAd("AD1");
    const visionByAdId = new Map([["AD1", [vision({ proofStrength: "strong", persuasionSignals: 6 })]]]);
    const out = attachCreativeWeaknessSignals(unit, visionByAdId);
    expect(out.adsets[0]!.notableAds[0]!.healthSignals).toBeUndefined();
  });

  it("sem visão pro adId → unidade sai intacta (mesma referência de conteúdo)", () => {
    const unit = unitWithNotableAd("AD1");
    const out = attachCreativeWeaknessSignals(unit, new Map());
    expect(out.adsets[0]!.notableAds[0]!.healthSignals).toBeUndefined();
  });
});

describe("computeDeactivatedCampaignIds (sincronização — achado real de campanha que some do cache)", () => {
  it("id cacheado que NÃO está mais no conjunto ativo → candidato a desativada", () => {
    const out = computeDeactivatedCampaignIds(new Set(["c1", "c2"]), new Set(["c1"]));
    expect(out).toEqual(["c2"]);
  });

  it("tudo ainda ativo → vazio (nada mudou, o caso comum)", () => {
    expect(computeDeactivatedCampaignIds(new Set(["c1", "c2"]), new Set(["c1", "c2"]))).toEqual([]);
  });

  it("nunca cacheado antes → nada a marcar (não é 'desativação', é ausência normal)", () => {
    expect(computeDeactivatedCampaignIds(new Set(), new Set(["c1"]))).toEqual([]);
  });

  it("campanha reativada (estava marcada, voltou a ativa) → não aparece mais como candidata", () => {
    expect(computeDeactivatedCampaignIds(new Set(["c1"]), new Set(["c1"]))).toEqual([]);
  });
});
