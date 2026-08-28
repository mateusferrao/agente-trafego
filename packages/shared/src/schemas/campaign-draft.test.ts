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
});
