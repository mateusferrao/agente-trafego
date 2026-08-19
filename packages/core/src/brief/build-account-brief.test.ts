import { describe, expect, it } from "vitest";
import type { AdEntity, InsightMetrics, InsightRow } from "@trafego/shared";
import { buildAccountBrief, type BuildAccountBriefInput } from "./index.js";

// helper: linha de insight (normalize só lê spend/impressions/clicks + conversions)
function row(
  entityId: string,
  level: InsightRow["level"],
  spend: number,
  impressions: number,
  clicks: number,
  purchases?: { count: number; value?: number },
): InsightRow {
  const metrics: InsightMetrics = { spend, impressions, clicks, ctr: 0, cpc: 0, cpm: 0 };
  return {
    entityId,
    level,
    date: "2026-08-10",
    metrics,
    ...(purchases
      ? { conversions: [{ goal: "purchase", count: purchases.count, ...(purchases.value ? { value: purchases.value } : {}) }] }
      : {}),
  };
}

const entities: AdEntity[] = [
  { id: "c1", level: "campaign", name: "Lançamento A", status: "active", objective: { goal: "purchase" } },
  { id: "c2", level: "campaign", name: "Lançamento B", status: "active", objective: { goal: "purchase" } },
];

function baseInput(overrides: Partial<BuildAccountBriefInput> = {}): BuildAccountBriefInput {
  return {
    account: { id: "act_1", name: "Conta Teste", currency: "BRL" },
    window: "últimos 7 dias",
    baselineWindow: "7 dias anteriores",
    goals: { targetCPA: 50 },
    entities,
    rows: [
      row("act_1", "account", 300, 10000, 200, { count: 5, value: 1500 }),
      row("c1", "campaign", 100, 4000, 80, { count: 4, value: 1200 }), // CPA 25 (bom)
      row("c2", "campaign", 200, 6000, 120, { count: 2, value: 300 }), // CPA 100 (acima da meta 50)
    ],
    baselineRows: [
      row("c1", "campaign", 90, 3800, 70, { count: 3, value: 900 }),
      row("c2", "campaign", 180, 5800, 110, { count: 3, value: 450 }),
    ],
    playbookCandidates: [],
    topN: 10,
    ...overrides,
  };
}

describe("buildAccountBrief", () => {
  it("monta o brief com totais, segmentos e flags de meta", () => {
    const result = buildAccountBrief(baseInput());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const { brief } = result;

    expect(brief.account.name).toBe("Conta Teste");
    expect(brief.totals.spend).toBe(300);
    expect(brief.segments.campaigns).toHaveLength(2);

    const c2 = brief.segments.campaigns.find((c) => c.id === "c2");
    expect(c2?.name).toBe("Lançamento B");
    expect(c2?.metrics.cpa).toBe(100);
    expect(c2?.flags).toContain("cpa_acima_da_meta");

    const c1 = brief.segments.campaigns.find((c) => c.id === "c1");
    expect(c1?.metrics.cpa).toBe(25);
    expect(c1?.flags).not.toContain("cpa_acima_da_meta");
  });

  it("calcula deltaVsBaseline quando há linha na janela-baseline", () => {
    const result = buildAccountBrief(baseInput());
    if (result.status !== "ok") return;
    const c1 = result.brief.segments.campaigns.find((c) => c.id === "c1");
    // CPA janela = 100/4 = 25; baseline = 90/3 = 30 → delta -5
    expect(c1?.deltaVsBaseline.cpa).toBeCloseTo(-5, 4);
  });

  it("respeita top-N por spend nos segmentos (sem flags forçando seleção)", () => {
    // goals vazio → sem flags; assim o top-N por spend manda sozinho
    const result = buildAccountBrief(baseInput({ topN: 1, goals: {} }));
    if (result.status !== "ok") return;
    // c2 (spend 200) entra por spend; c1 (spend 100) vai p/ a cauda
    expect(result.brief.segments.campaigns.map((c) => c.id)).toEqual(["c2"]);
    expect(result.brief.aggregatesRest.count).toBe(1);
    expect(result.brief.aggregatesRest.spend).toBe(100);
  });

  it("sinaliza 'sem atividade' quando não há gasto/impressões (conta parada)", () => {
    const result = buildAccountBrief(baseInput({ rows: [], baselineRows: [] }));
    expect(result.status).toBe("empty");
  });
});
