import { describe, expect, it } from "vitest";
import type { EntitySummary } from "@trafego/shared";
import {
  DEFAULT_QUALITY_THRESHOLDS as T,
  classifyTier,
  computeEligibility,
  detectHealthSignals,
  enrichEntitiesQuality,
} from "./index.js";

describe("computeEligibility", () => {
  it("significância exige volume E baseline (proxy de ≥ janela)", () => {
    expect(computeEligibility({ conversions: 25, clicks: 10, hasBaseline: true }, T).hasSignificance).toBe(true);
    expect(computeEligibility({ conversions: 200, clicks: 0, hasBaseline: false }, T).hasSignificance).toBe(false);
    expect(computeEligibility({ conversions: 2, clicks: 40, hasBaseline: true }, T).hasSignificance).toBe(false);
  });
  it("sem baseline = em learning (entidade nova)", () => {
    expect(computeEligibility({ conversions: 0, clicks: 0, hasBaseline: false }, T).inLearning).toBe(true);
    expect(computeEligibility({ conversions: 30, clicks: 0, hasBaseline: true }, T).inLearning).toBe(false);
  });
});

describe("detectHealthSignals", () => {
  it("fadiga = 2+ sinais (CTR caiu + freq alta)", () => {
    const s = detectHealthSignals({ frequency: 3.4, ctrDropPct: 30, costRisePct: 0, hasSignificance: true }, T);
    expect(s).toContain("creative_fatigue");
    expect(s).toContain("audience_saturation");
  });
  it("1 sinal só não é fadiga", () => {
    expect(detectHealthSignals({ ctrDropPct: 30, costRisePct: 0, hasSignificance: true }, T)).not.toContain("creative_fatigue");
  });
  it("sem significância → low_volume", () => {
    expect(detectHealthSignals({ ctrDropPct: 0, costRisePct: 0, hasSignificance: false }, T)).toContain("low_volume");
  });
});

describe("classifyTier", () => {
  const base = { hasSignificance: true, beatsTarget: false, belowTarget: false, worseThanBaseline: false, topEfficiencyNoTarget: false };
  it("zombie: gastou e não converteu (independe de significância)", () => {
    expect(classifyTier({ ...base, conversions: 0, spend: 200, hasSignificance: false }, T)).toBe("zombie");
  });
  it("sem significância (não-zombie) → sem tier", () => {
    expect(classifyTier({ ...base, conversions: 3, spend: 200, hasSignificance: false }, T)).toBeUndefined();
  });
  it("bate meta → winner; abaixo da meta → underperformer", () => {
    expect(classifyTier({ ...base, conversions: 30, spend: 200, beatsTarget: true }, T)).toBe("winner");
    expect(classifyTier({ ...base, conversions: 30, spend: 200, belowTarget: true }, T)).toBe("underperformer");
  });
  it("default significante = performer", () => {
    expect(classifyTier({ ...base, conversions: 30, spend: 200 }, T)).toBe("performer");
  });
});

function summary(over: Partial<EntitySummary> & { id: string }): EntitySummary {
  return {
    level: "campaign",
    name: over.id,
    status: "active",
    metrics: { spend: 100, impressions: 5000, clicks: 150, ctr: 2.5, cpc: 0.67, cpm: 20 },
    deltaVsBaseline: { ctr: 0 },
    flags: [],
    conversionBasis: "target",
    ...over,
  };
}

describe("enrichEntitiesQuality (integração das peças)", () => {
  it("marca zombie e anexa eligibility/healthSignals", () => {
    const out = enrichEntitiesQuality(
      [summary({ id: "Z", metrics: { spend: 300, impressions: 9000, clicks: 40, ctr: 0.4, cpc: 7.5, cpm: 33, conversions: 0 }, deltaVsBaseline: { ctr: 0 } })],
      {},
      { thresholds: T, hasTarget: false, currency: "BRL" },
    );
    expect(out[0]!.tier).toBe("zombie");
    expect(out[0]!.eligibility).toBeDefined();
  });

  it("winner por bater a meta de CPA", () => {
    const out = enrichEntitiesQuality(
      [summary({ id: "W", metrics: { spend: 400, impressions: 20000, clicks: 500, ctr: 2.5, cpc: 0.8, cpm: 20, conversions: 40, cpa: 10 }, deltaVsBaseline: { ctr: 0.1 } })],
      { targetCPA: 15 },
      { thresholds: T, hasTarget: true, currency: "BRL" },
    );
    expect(out[0]!.tier).toBe("winner");
  });
});
