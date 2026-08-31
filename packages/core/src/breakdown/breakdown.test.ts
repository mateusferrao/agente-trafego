import { describe, expect, it } from "vitest";
import type { BreakdownSegment } from "@trafego/shared";
import { DEFAULT_BREAKDOWN_THRESHOLDS, hasMaterialSpread } from "./index.js";

function segment(key: string, spend: number, cpa?: number, cpc?: number): BreakdownSegment {
  return {
    key,
    label: key,
    metrics: { spend, impressions: 1000, clicks: 20, ctr: 2, cpc: cpc ?? 0, cpm: 10, ...(cpa !== undefined ? { cpa } : {}) },
  };
}

describe("hasMaterialSpread (S7 — gate de materialidade)", () => {
  it("spread grande (CPA) acima do limiar → material", () => {
    const segments = [segment("A", 100, 5), segment("B", 100, 10)]; // +100%
    expect(hasMaterialSpread(segments, DEFAULT_BREAKDOWN_THRESHOLDS)).toBe(true);
  });

  it("spread pequeno (dentro do limiar) → não material", () => {
    const segments = [segment("A", 100, 9), segment("B", 100, 10)]; // +11%
    expect(hasMaterialSpread(segments, DEFAULT_BREAKDOWN_THRESHOLDS)).toBe(false);
  });

  it("segmentos abaixo do piso de gasto NÃO entram na comparação (evita outlier de gasto ínfimo)", () => {
    const segments = [segment("A", 1, 1), segment("B", 100, 10)]; // A tem CPA baixo mas gasto irrisório
    expect(hasMaterialSpread(segments, DEFAULT_BREAKDOWN_THRESHOLDS)).toBe(false); // só B é elegível → <2 custos comparáveis
  });

  it("menos de 2 segmentos elegíveis → nunca material (nada pra comparar)", () => {
    expect(hasMaterialSpread([segment("A", 100, 10)], DEFAULT_BREAKDOWN_THRESHOLDS)).toBe(false);
    expect(hasMaterialSpread([], DEFAULT_BREAKDOWN_THRESHOLDS)).toBe(false);
  });

  it("sem CPA (nenhuma conversão) → cai pra CPC como custo comparável", () => {
    const segments = [segment("A", 100, undefined, 1), segment("B", 100, undefined, 3)]; // +200%
    expect(hasMaterialSpread(segments, DEFAULT_BREAKDOWN_THRESHOLDS)).toBe(true);
  });
});
