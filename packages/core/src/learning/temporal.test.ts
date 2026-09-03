import { describe, expect, it } from "vitest";
import {
  detectConversionLagPrior,
  detectFatigueTimingPrior,
  temporalConfidence,
  type AccountConversionDay,
  type CampaignFatigueSeries,
} from "./temporal.js";

// CTR que segura alto na largada e despenca no dia `fatigueDay` (fadiga clara).
function fatiguingCtr(fatigueDay: number, length = 12): number[] {
  return Array.from({ length }, (_, day) => (day < fatigueDay ? 5 : 1));
}

describe("detectFatigueTimingPrior", () => {
  it("nasce com >= K campanhas com dia-de-fadiga APERTADO (variância baixa)", () => {
    const campaigns: CampaignFatigueSeries[] = [
      { campaignId: "c1", ctrByDay: fatiguingCtr(6) },
      { campaignId: "c2", ctrByDay: fatiguingCtr(6) },
      { campaignId: "c3", ctrByDay: fatiguingCtr(7) },
    ];
    const prior = detectFatigueTimingPrior(campaigns);
    expect(prior).not.toBeNull();
    expect(prior?.key).toMatchObject({ scope: "account", dimension: "creative" });
    expect(prior?.evidence.pattern).toBe("account_fatigue_timing");
    expect(prior?.evidence.days).toBe(6); // ~ média (6,6,7)
    expect(prior?.confidence).toBeGreaterThanOrEqual(0.7); // apertado → alcança o prompt
  });

  it("NÃO nasce com < K campanhas", () => {
    const campaigns: CampaignFatigueSeries[] = [
      { campaignId: "c1", ctrByDay: fatiguingCtr(6) },
      { campaignId: "c2", ctrByDay: fatiguingCtr(6) },
    ];
    expect(detectFatigueTimingPrior(campaigns)).toBeNull();
  });

  it("NÃO nasce quando os dias-de-fadiga são DISPERSOS (variância alta)", () => {
    const campaigns: CampaignFatigueSeries[] = [
      { campaignId: "c1", ctrByDay: fatiguingCtr(4, 20) },
      { campaignId: "c2", ctrByDay: fatiguingCtr(10, 20) },
      { campaignId: "c3", ctrByDay: fatiguingCtr(16, 20) },
    ];
    expect(detectFatigueTimingPrior(campaigns)).toBeNull();
  });

  it("ignora campanha sem fadiga (CTR estável) e série curta", () => {
    const campaigns: CampaignFatigueSeries[] = [
      { campaignId: "estavel", ctrByDay: [5, 5, 5, 5, 5, 5] },
      { campaignId: "curta", ctrByDay: [5, 1] },
      { campaignId: "c1", ctrByDay: fatiguingCtr(6) },
    ];
    // só 1 com fadiga → abaixo de K.
    expect(detectFatigueTimingPrior(campaigns)).toBeNull();
  });
});

describe("detectConversionLagPrior", () => {
  // gasto varia por dia; conversão = espelho do gasto DESLOCADO `lag` dias à frente.
  function seriesWithLag(lag: number, n = 20): AccountConversionDay[] {
    const spend = Array.from({ length: n }, (_, i) => 10 + ((i * 7) % 13)); // varia
    return Array.from({ length: n }, (_, i) => ({
      spend: spend[i]!,
      conversions: i >= lag ? spend[i - lag]! / 5 : 0,
    }));
  }

  it("detecta o lag típico (conversão atrasa D dias em relação ao gasto)", () => {
    const prior = detectConversionLagPrior(seriesWithLag(3));
    expect(prior).not.toBeNull();
    expect(prior?.key).toMatchObject({ scope: "account", dimension: "conversion" });
    expect(prior?.evidence.pattern).toBe("account_conversion_lag");
    expect(prior?.evidence.days).toBe(3);
  });

  it("NÃO nasce sem histórico mínimo", () => {
    expect(detectConversionLagPrior(seriesWithLag(3, 5))).toBeNull();
  });

  it("NÃO nasce quando não há lag real (conversão acompanha o gasto no MESMO dia)", () => {
    const prior = detectConversionLagPrior(seriesWithLag(0));
    expect(prior).toBeNull(); // melhor lag 0 → sem atraso a ensinar
  });
});

describe("temporalConfidence", () => {
  it("padrão apertado (strength alta) em 3 passos alcança o limiar do prompt (>= 0.7)", () => {
    expect(temporalConfidence(3, 1)).toBeGreaterThanOrEqual(0.7);
  });
  it("padrão frouxo (strength baixa) fica bem abaixo do prompt", () => {
    expect(temporalConfidence(3, 0.2)).toBeLessThan(0.5);
  });
  it("nunca passa do teto temporal (0.85)", () => {
    expect(temporalConfidence(50, 1)).toBeLessThanOrEqual(0.85);
  });
});
