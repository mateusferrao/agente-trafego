import type { CampaignDraftSpec } from "@trafego/shared";
import { describe, expect, it } from "vitest";
import { applyDraftEdit, conversionRequiresPixel } from "./refine.js";

const fromScratch: CampaignDraftSpec = {
  version: 1,
  currency: "BRL",
  dailyBudgetMinor: 5000,
  activation: "paused",
  objective: "messaging_started",
  targeting: { kind: "advantage_plus" },
  variantsCount: 2,
  copyVariants: [
    { primaryText: "t1", headline: "h1" },
    { primaryText: "t2", headline: "h2" },
  ],
  creative: { assetId: "a1", format: "video", origin: "reuse", metaVideoId: "v1" },
  pageId: "page_1",
};

const duplicate: CampaignDraftSpec = {
  version: 1,
  currency: "BRL",
  dailyBudgetMinor: 6000,
  activation: "active",
};

const noCap = { hasPixel: true } as const;

describe("conversionRequiresPixel", () => {
  it("venda/lead exigem pixel; mensagem/app_install não", () => {
    expect(conversionRequiresPixel("purchase")).toBe(true);
    expect(conversionRequiresPixel("lead")).toBe(true);
    expect(conversionRequiresPixel("messaging_started")).toBe(false);
    expect(conversionRequiresPixel("app_install")).toBe(false);
  });
});

describe("applyDraftEdit — merge puro do rascunho", () => {
  it("from_scratch: edita nomes + ativação e mantém o resto", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { campaignName: "Nova", adsetName: "Conj", activation: "active" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.campaignName).toBe("Nova");
    expect(r.value.spec.adsetName).toBe("Conj");
    expect(r.value.spec.activation).toBe("active");
    expect(r.value.spec.creative).toEqual(fromScratch.creative);
  });

  it("from_scratch: budget é clampado ao teto e sinaliza corte", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { budgetMinor: 20000 }, { hasPixel: true, budgetCapMinor: 10000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.dailyBudgetMinor).toBe(10000);
    expect(r.value.clampedByCap).toBe(true);
  });

  it("from_scratch: edição sem clamp LIMPA um requestedDailyBudgetMinor de clamp anterior", () => {
    // spec já veio de um clamp anterior (pediu 150, virou 100); agora o usuário edita p/ 50 (< teto).
    const clamped: CampaignDraftSpec = { ...fromScratch, dailyBudgetMinor: 10000, requestedDailyBudgetMinor: 15000 };
    const r = applyDraftEdit("from_scratch", clamped, { budgetMinor: 5000 }, { hasPixel: true, budgetCapMinor: 10000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.dailyBudgetMinor).toBe(5000);
    expect(r.value.clampedByCap).toBe(false);
    expect(r.value.spec.requestedDailyBudgetMinor).toBeUndefined(); // não mostra "reduzido de" falso
  });

  it("from_scratch: objetivo que exige pixel SEM pixel → erro", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { objective: "purchase" }, { hasPixel: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("objective_requires_pixel");
  });

  it("from_scratch: objetivo que exige pixel COM pixel → ok, grava objetivo + pixelId", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { objective: "purchase", pixelId: "PX9" }, { hasPixel: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.objective).toBe("purchase");
    expect(r.value.spec.pixelId).toBe("PX9");
  });

  it("duplicate: tentar editar pixelId → erro field_not_editable", () => {
    const r = applyDraftEdit("duplicate", duplicate, { pixelId: "PX9" }, noCap);
    expect(r.ok).toBe(false);
  });

  it("from_scratch: objetivo que NÃO exige pixel sem pixel → ok", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { objective: "app_install" }, { hasPixel: false });
    expect(r.ok).toBe(true);
  });

  it("from_scratch: copyVariants vazio → erro (mín 1)", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { copyVariants: [] }, noCap);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("empty_variants");
  });

  it("duplicate: edita budget/ativação/suffixLabel", () => {
    const r = applyDraftEdit("duplicate", duplicate, { budgetMinor: 7000, activation: "paused", suffixLabel: "escala 2" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.dailyBudgetMinor).toBe(7000);
    expect(r.value.spec.activation).toBe("paused");
    expect(r.value.spec.suffixLabel).toBe("escala 2");
  });

  it("duplicate: tentar editar objetivo/nome → erro field_not_editable", () => {
    const r = applyDraftEdit("duplicate", duplicate, { objective: "purchase" }, noCap);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("field_not_editable");
  });
});
