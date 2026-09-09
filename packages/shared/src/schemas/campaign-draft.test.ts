import { describe, expect, it } from "vitest";
import type { CampaignDraftSpec } from "../types/index.js";
import { campaignDraftSpecSchema } from "./index.js";

// Spec from_scratch completo (com nomes editados — Fatia 7).
const fromScratch: CampaignDraftSpec = {
  version: 1,
  currency: "BRL",
  dailyBudgetMinor: 5000,
  activation: "paused",
  objective: "purchase",
  targeting: { kind: "advantage_plus" },
  variantsCount: 2,
  copyVariants: [
    { primaryText: "Texto 1", headline: "Título 1", cta: "shop_now", adName: "Anúncio A" },
    { primaryText: "Texto 2", headline: "Título 2" },
  ],
  creative: { assetId: "reuse", format: "video", origin: "reuse", metaVideoId: "123" },
  pageId: "page_1",
  campaignName: "Minha campanha",
  adsetName: "Meu conjunto",
};

describe("campaignDraftSpecSchema — shape-validation (não regra de negócio)", () => {
  it("aceita um from_scratch completo com nomes editados", () => {
    expect(campaignDraftSpecSchema.safeParse(fromScratch).success).toBe(true);
  });

  it("aceita um duplicate mínimo (só budget/activation + suffixLabel)", () => {
    const dup: CampaignDraftSpec = {
      version: 1,
      currency: "BRL",
      dailyBudgetMinor: 6000,
      activation: "active",
      suffixLabel: "escala 2",
    };
    expect(campaignDraftSpecSchema.safeParse(dup).success).toBe(true);
  });

  it("SEGURANÇA: aceita um spec PRÉ-ADENDO (sem nenhum campo de nome) — não rejeita rascunho em voo", () => {
    const legacy: CampaignDraftSpec = {
      version: 1,
      currency: "BRL",
      dailyBudgetMinor: 5000,
      activation: "paused",
      objective: "lead",
      targeting: { kind: "reuse_adset", sourceAdsetId: "as_1" },
      variantsCount: 2,
      copyVariants: [{ primaryText: "t", headline: "h" }],
      creative: { assetId: "a1", format: "image", origin: "upload", metaImageHash: "hash" },
      pageId: "page_1",
    };
    expect(campaignDraftSpecSchema.safeParse(legacy).success).toBe(true);
  });

  it("rejeita nome de campanha vazio", () => {
    expect(campaignDraftSpecSchema.safeParse({ ...fromScratch, campaignName: "" }).success).toBe(false);
  });

  it("rejeita objetivo fora da taxonomia", () => {
    expect(campaignDraftSpecSchema.safeParse({ ...fromScratch, objective: "banana" }).success).toBe(false);
  });

  it("rejeita budget <= 0", () => {
    expect(campaignDraftSpecSchema.safeParse({ ...fromScratch, dailyBudgetMinor: 0 }).success).toBe(false);
  });

  it("rejeita copy com primaryText vazio", () => {
    const bad = { ...fromScratch, copyVariants: [{ primaryText: "", headline: "h" }] };
    expect(campaignDraftSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("aceita explicit com público salvo (colapso de custom_audiences → explicit, Slice 1)", () => {
    const withSavedAudience: CampaignDraftSpec = {
      ...fromScratch,
      targeting: { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], customAudienceIncludeIds: ["ca_1"], customAudienceExcludeIds: [] },
    };
    expect(campaignDraftSpecSchema.safeParse(withSavedAudience).success).toBe(true);
  });

  it("rejeita o kind removido custom_audiences (corte seco)", () => {
    expect(campaignDraftSpecSchema.safeParse({ ...fromScratch, targeting: { kind: "custom_audiences", includeIds: ["ca_1"], excludeIds: [] } }).success).toBe(false);
  });

  it("aceita reuse_adset com snapshot resolvido (subfatia 2 — cache do público real)", () => {
    const withResolved: CampaignDraftSpec = {
      ...fromScratch,
      targeting: {
        kind: "reuse_adset",
        sourceAdsetId: "as_1",
        resolved: {
          geo: { cities: [{ key: "2430536", name: "Belo Horizonte" }] },
          ageMin: 35,
          ageMax: 64,
          expansionRaw: { advantageAudience: 0, relaxCustomAudience: 0, relaxLookalike: 0 },
        },
      },
    };
    expect(campaignDraftSpecSchema.safeParse(withResolved).success).toBe(true);
  });

  it("aceita reuse_adset SEM resolved (rascunho pré-adendo — migração de graça)", () => {
    const legacyStillValid: CampaignDraftSpec = { ...fromScratch, targeting: { kind: "reuse_adset", sourceAdsetId: "as_1" } };
    expect(campaignDraftSpecSchema.safeParse(legacyStillValid).success).toBe(true);
  });

  it("C1: aceita budgetMode cbo/abo e rejeita valor fora do enum", () => {
    expect(campaignDraftSpecSchema.safeParse({ ...fromScratch, budgetMode: "cbo" }).success).toBe(true);
    expect(campaignDraftSpecSchema.safeParse({ ...fromScratch, budgetMode: "abo" }).success).toBe(true);
    expect(campaignDraftSpecSchema.safeParse({ ...fromScratch, budgetMode: "xyz" }).success).toBe(false);
  });

  it("C1 retrocompat: budgetMode AUSENTE segue válido (rascunho pré-C1 = ABO no apply)", () => {
    const { budgetMode: _omit, ...noMode } = { ...fromScratch, budgetMode: "cbo" as const };
    expect(campaignDraftSpecSchema.safeParse(noMode).success).toBe(true);
  });
});
