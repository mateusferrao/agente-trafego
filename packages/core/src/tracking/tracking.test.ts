import { describe, expect, it } from "vitest";
import { buildTrackingRecommendation, detectTrackingHealth } from "./index.js";

const T = { ratio: 50, minFunnel: 50 };

describe("detectTrackingHealth", () => {
  it("meta de venda + muito funil + pouca conversão rastreada → suspeito (caso Steticos)", () => {
    const h = detectTrackingHealth({ conversionGoal: "purchase", funnelStarted: 2896, trackedConversions: 8, thresholds: T });
    expect(h).toMatchObject({ suspect: true, funnelStarted: 2896, trackedConversions: 8 });
    expect(h!.ratio).toBeGreaterThanOrEqual(50);
  });

  it("razão plausível (10:1) não dispara", () => {
    expect(detectTrackingHealth({ conversionGoal: "purchase", funnelStarted: 500, trackedConversions: 50, thresholds: T })).toBeUndefined();
  });

  it("volume de funil abaixo do piso não dispara", () => {
    expect(detectTrackingHealth({ conversionGoal: "purchase", funnelStarted: 40, trackedConversions: 0, thresholds: T })).toBeUndefined();
  });

  it("meta on-platform (conversa) nunca dispara — a conversão É rastreada", () => {
    expect(detectTrackingHealth({ conversionGoal: "messaging_started", funnelStarted: 3000, trackedConversions: 0, thresholds: T })).toBeUndefined();
  });

  it("sem meta de negócio → undefined", () => {
    expect(detectTrackingHealth({ funnelStarted: 3000, trackedConversions: 0, thresholds: T })).toBeUndefined();
  });
});

describe("buildTrackingRecommendation (D — medição furada vira recomendação de topo)", () => {
  it("sinal suspeito → recomendação com os números do sinal", () => {
    const rec = buildTrackingRecommendation({ suspect: true, funnelStarted: 2896, trackedConversions: 8, ratio: 362 });
    expect(rec).not.toBeNull();
    expect(rec!.title).toMatch(/medição/i);
    expect(rec!.rationale).toContain("2896");
    expect(rec!.rationale).toContain("8");
    expect(rec!.rationale).toContain("362");
  });

  it("sem suspeita (undefined) → null (nada a recomendar)", () => {
    expect(buildTrackingRecommendation(undefined)).toBeNull();
  });
});
