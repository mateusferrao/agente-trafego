import { describe, expect, it } from "vitest";
import type { CampaignDraft, CampaignDraftSpec, DraftKind, GuardrailConfig } from "@trafego/shared";
import { GUARDRAIL_DEFAULTS } from "@trafego/shared";
import { applyCreationGuardrails } from "./index.js";

function draft(over: Partial<CampaignDraftSpec> = {}, kind: DraftKind = "from_scratch"): CampaignDraft {
  return {
    kind,
    spec: {
      version: 1,
      objective: "purchase",
      currency: "BRL",
      dailyBudgetMinor: 3000,
      targeting: { kind: "advantage_plus" },
      variantsCount: 2,
      copyVariants: [],
      activation: "active",
      ...over,
    },
  };
}

const cfg: GuardrailConfig = {
  ...GUARDRAIL_DEFAULTS,
  maxNewDailyBudgetMinor: 5000,
  maxNewCampaignsPerDay: 2,
};

describe("applyCreationGuardrails", () => {
  it("kill switch descarta a criação", () => {
    const res = applyCreationGuardrails(draft(), { ...cfg, killSwitch: true });
    expect(res.allowed).toBeNull();
    expect(res.dropped?.reason).toContain("kill");
  });

  it("descarta ao atingir o teto de campanhas novas/dia (cross-run)", () => {
    const res = applyCreationGuardrails(draft(), cfg, { createdCampaignsToday: 2 });
    expect(res.allowed).toBeNull();
    expect(res.dropped?.reason).toContain("campanhas");
  });

  it("faz clamp do budget diário novo acima do teto (não descarta)", () => {
    const res = applyCreationGuardrails(draft({ dailyBudgetMinor: 8000 }), cfg);
    expect(res.allowed).not.toBeNull();
    expect(res.allowed?.spec.dailyBudgetMinor).toBe(5000);
    expect(res.clampedFromMinor).toBe(8000);
    expect(res.dropped).toBeNull();
  });

  it("passa quando dentro dos limites (sem clamp)", () => {
    const res = applyCreationGuardrails(draft({ dailyBudgetMinor: 3000 }), cfg, { createdCampaignsToday: 0 });
    expect(res.allowed?.spec.dailyBudgetMinor).toBe(3000);
    expect(res.clampedFromMinor).toBeUndefined();
    expect(res.dropped).toBeNull();
  });

  it("cai nos defaults quando o config não traz os limites de criação", () => {
    // cfg sem os campos de criação → usa GUARDRAIL_DEFAULTS (teto 5000).
    const bare: GuardrailConfig = {
      maxBudgetChangePct: 20,
      maxEntitiesPerDay: 3,
      allowedActions: ["pause_entity"],
      dryRun: true,
      killSwitch: false,
    };
    const res = applyCreationGuardrails(draft({ dailyBudgetMinor: 8000 }), bare);
    expect(res.allowed?.spec.dailyBudgetMinor).toBe(GUARDRAIL_DEFAULTS.maxNewDailyBudgetMinor);
    expect(res.clampedFromMinor).toBe(8000);
  });
});
