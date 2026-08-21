import { describe, expect, it } from "vitest";
import type { InsightRow } from "@trafego/shared";
import { computeLiveTotals } from "./index.js";

/** Linha de conta (nível account) — computeAccountTotals isola o nível conta. */
function acctRow(date: string, spend: number, purchases: number): InsightRow {
  return {
    entityId: "ACT1",
    level: "account",
    date,
    metrics: { spend, impressions: 1000, clicks: 20, ctr: 0, cpc: 0, cpm: 0 },
    conversions: [{ goal: "purchase", count: purchases, value: spend * 5 }],
  };
}

describe("computeLiveTotals", () => {
  it("com conversão de negócio → totais + CPA/ROAS da conta + delta vs baseline", () => {
    const totals = computeLiveTotals({
      rows: [acctRow("2026-08-17", 100, 5), acctRow("2026-08-18", 100, 5)],
      baselineRows: [acctRow("2026-08-15", 50, 5), acctRow("2026-08-16", 50, 5)],
      goals: { conversionGoal: "purchase" },
    });
    expect(totals).not.toBeNull();
    expect(totals!.spend).toBe(200);
    expect(totals!.cpa).toBeCloseTo(20); // 200 / 10 compras
    expect(totals!.roas).toBeCloseTo(5); // valor 1000 / spend 200
    expect(totals!.delta).toBeTruthy(); // tem baseline → delta presente
  });

  it("sem conversão de negócio → totais sem CPA (nunca média enganosa no total)", () => {
    const totals = computeLiveTotals({
      rows: [acctRow("2026-08-18", 100, 5)],
      baselineRows: [],
      goals: {},
    });
    expect(totals).not.toBeNull();
    expect(totals!.spend).toBe(100);
    expect(totals!.cpa).toBeUndefined();
  });

  it("sem atividade (spend+impressions 0) → null", () => {
    const totals = computeLiveTotals({
      rows: [
        { entityId: "ACT1", level: "account", date: "2026-08-18", metrics: { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0 } },
      ],
      baselineRows: [],
      goals: {},
    });
    expect(totals).toBeNull();
  });

  it("sem linhas → null", () => {
    expect(computeLiveTotals({ rows: [], baselineRows: [], goals: {} })).toBeNull();
  });
});
