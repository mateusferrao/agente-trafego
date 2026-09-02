import { describe, expect, it } from "vitest";
import type { BreakdownSegment } from "@trafego/shared";
import { DEFAULT_BREAKDOWN_THRESHOLDS, eligibleBreakdownSegments, hasMaterialSpread } from "./index.js";

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

  it("BUG corrigido: 1 segmento com CPA + 2 com só CPC → NUNCA mistura as bases (menos de 2 com CPA → cai pra pool de CPC, ignora o CPA solto)", () => {
    // A tem CPA de venda (200, caro de verdade); B/C não convertem (só CPC baixo). Antes do
    // fix, os 3 custos entravam no MESMO pool (200 vs 1 vs 1.2) → spread gigante + "mais
    // barato" = quem não converte (non sequitur). Com a base isolada: só B/C entram (CPC,
    // 2 elegíveis), spread pequeno (20%) → não material.
    const segments = [segment("A", 100, 200), segment("B", 100, undefined, 1), segment("C", 100, undefined, 1.2)];
    expect(hasMaterialSpread(segments, DEFAULT_BREAKDOWN_THRESHOLDS)).toBe(false);
  });

  it("BUG corrigido: mesmo cenário, mas CPC com spread grande → material só pela base CPC (nunca usa o 200 de A)", () => {
    const segments = [segment("A", 100, 200), segment("B", 100, undefined, 1), segment("C", 100, undefined, 3)]; // CPC +200%
    expect(hasMaterialSpread(segments, DEFAULT_BREAKDOWN_THRESHOLDS)).toBe(true);
  });
});

describe("eligibleBreakdownSegments (S7 — segmentos que o brief pode anexar)", () => {
  it("filtra segmentos abaixo do piso de gasto — o brief NUNCA recebe o que o gate excluiu", () => {
    const segments = [segment("A", 1, 1), segment("B", 100, 10)];
    expect(eligibleBreakdownSegments(segments, DEFAULT_BREAKDOWN_THRESHOLDS).map((s) => s.key)).toEqual(["B"]);
  });
});
