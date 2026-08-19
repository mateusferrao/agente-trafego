import { describe, expect, it } from "vitest";
import type { AccountBrief, EntitySummary, InsightRow } from "@trafego/shared";
import {
  assembleBrief,
  computeDerived,
  computeTrends,
  normalize,
  summarizeRest,
} from "./index.js";

function dailyRow(date: string, spend: number): InsightRow {
  return {
    entityId: "AD1",
    level: "ad",
    date,
    metrics: { spend, impressions: 1000, clicks: 20, ctr: 0, cpc: 0, cpm: 0 },
    conversions: [
      { goal: "purchase", count: 5, value: spend * 5 },
      { goal: "messaging_started", count: 25 },
    ],
  };
}

describe("normalize", () => {
  it("soma linhas diárias por entidade + funde o breakdown de conversões", () => {
    const [e] = normalize([dailyRow("2026-08-01", 100), dailyRow("2026-08-02", 100)]);
    expect(e).toMatchObject({ entityId: "AD1", level: "ad", spend: 200, impressions: 2000, clicks: 40 });
    expect(e!.conversions).toEqual([
      { goal: "purchase", count: 10, value: 1000 },
      { goal: "messaging_started", count: 50 },
    ]);
  });
});

describe("computeDerived — conversão por objetivo", () => {
  const [entity] = normalize([dailyRow("2026-08-01", 100), dailyRow("2026-08-02", 100)]);

  it("objetivo purchase → CPA/ROAS da compra", () => {
    const m = computeDerived(entity!, { goal: "purchase" });
    expect(m).toMatchObject({ spend: 200, conversions: 10, cpa: 20, roas: 5 });
  });

  it("override do agente (messaging) vence → conta conversas, sem ROAS (sem valor)", () => {
    const m = computeDerived(entity!, { goal: "purchase" }, { goal: "messaging_started" });
    expect(m.conversions).toBe(50);
    expect(m.cpa).toBe(4); // 200 / 50
    expect(m.roas).toBeUndefined();
  });

  it("sem objetivo → só CPC/CPM (nada de CPA)", () => {
    const m = computeDerived(entity!);
    expect(m.cpa).toBeUndefined();
    expect(m.conversions).toBeUndefined();
    expect(m.cpc).toBe(5); // 200 / 40 cliques
  });
});

describe("computeTrends", () => {
  it("série diária com derivadas por dia", () => {
    const trends = computeTrends([dailyRow("2026-08-02", 100), dailyRow("2026-08-01", 100)]);
    expect(trends.map((t) => t.date)).toEqual(["2026-08-01", "2026-08-02"]); // ordenado
    expect(trends[0]!.metrics.cpc).toBe(5); // 100 / 20
    expect(trends[0]!.metrics.ctr).toBe(2); // 20/1000 * 100
  });
});

describe("summarizeRest", () => {
  it("resume a cauda não-selecionada (count/spend/avgCpa)", () => {
    const mk = (id: string, spend: number, cpa?: number): EntitySummary => ({
      id,
      level: "ad",
      name: id,
      status: "active",
      metrics: { spend, impressions: 1, clicks: 1, ctr: 0, cpc: 0, cpm: 0, ...(cpa ? { cpa } : {}) },
      deltaVsBaseline: {},
      flags: [],
    });
    const all = [mk("a", 100, 10), mk("b", 50, 20), mk("c", 30)];
    const rest = summarizeRest(all, [all[0]!]); // seleciona só "a"
    expect(rest).toEqual({ count: 2, spend: 80, avgCpa: 20 });
  });
});

describe("assembleBrief", () => {
  it("compõe um AccountBrief válido (creatives vazio até a visão da 3b)", () => {
    const brief = assembleBrief({
      account: { id: "1", name: "Conta", currency: "BRL", window: "last_7d", baselineWindow: "prev_7d" },
      goals: { targetCPA: 25 },
      // totals = InsightMetrics & { delta } — o index signature de InsightMetrics
      // briga com `delta` no literal (peculiaridade do tipo; construção real = 3a).
      totals: { spend: 200, impressions: 2000, clicks: 40, ctr: 2, cpc: 5, cpm: 100, delta: {} } as AccountBrief["totals"],
      trends: [],
      campaigns: [],
      adsets: [],
      ads: [],
      anomalies: [],
      creatives: [],
      playbookCandidates: [],
      memory: { objectives: [], pastActions: [], rejected: [] },
      aggregatesRest: { count: 0, spend: 0 },
    });
    expect(brief.creatives).toEqual([]);
    expect(brief.segments).toHaveProperty("campaigns");
    expect(brief.totals.spend).toBe(200);
    expect(brief.goals.targetCPA).toBe(25);
  });
});
