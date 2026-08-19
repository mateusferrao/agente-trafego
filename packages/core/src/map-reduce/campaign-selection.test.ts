import { describe, expect, it } from "vitest";
import type { CampaignUnit, EntitySummary, InsightMetrics } from "@trafego/shared";
import { selectCampaignsToAnalyze } from "./campaign-selection.js";
import type { LastUnit } from "./index.js";

function metrics(spend: number): InsightMetrics {
  return { spend, impressions: 1000, clicks: 50, ctr: 5, cpc: 1, cpm: 1 };
}

function unit(id: string, spend: number, flags: string[] = []): CampaignUnit {
  const campaign: EntitySummary = {
    id,
    level: "campaign",
    name: id,
    status: "active",
    metrics: metrics(spend),
    deltaVsBaseline: {},
    flags,
  };
  return { campaign, adsets: [] };
}

const CFG_FULL = { policy: "full_every_run", materialChangePct: 15, isDeepRun: false, topN: 1 } as const;

describe("selectCampaignsToAnalyze", () => {
  it("top-N re-nivelado: flagada sempre entra + top-N por escore; resto resumido", () => {
    const units = [unit("C1", 100, ["cpa_acima_da_meta"]), unit("C2", 200), unit("C3", 50), unit("C4", 10)];
    const sel = selectCampaignsToAnalyze(units, new Map(), CFG_FULL);

    // candidatas = flagada C1 + top-1 por escore (C2). C3/C4 → resumidas.
    expect(sel.toAnalyze.map((u) => u.campaign.id).sort()).toEqual(["C1", "C2"]);
    expect(sel.summarized.map((u) => u.campaign.id).sort()).toEqual(["C3", "C4"]);
  });

  it("incremental: candidata inalterada herda; nova é analisada", () => {
    const units = [unit("C1", 100, ["cpa_acima_da_meta"]), unit("C2", 200)];
    const last = new Map<string, LastUnit>([
      ["C1", { metrics: { spend: 100, ctr: 5 }, flags: ["cpa_acima_da_meta"] }],
    ]);
    const sel = selectCampaignsToAnalyze(units, last, {
      policy: "deep_periodic_incremental",
      materialChangePct: 15,
      isDeepRun: false,
      topN: 5,
    });

    // C1 dentro do top-N mas inalterada → herda; C2 nova → analisa.
    expect(sel.toAnalyze.map((u) => u.campaign.id)).toEqual(["C2"]);
    expect(sel.toInherit.map((u) => u.campaign.id)).toEqual(["C1"]);
    expect(sel.summarized).toHaveLength(0);
  });

  it("deep run: todas as candidatas do top-N são analisadas", () => {
    const units = [unit("C1", 100), unit("C2", 200)];
    const last = new Map<string, LastUnit>([["C1", { metrics: { spend: 100 }, flags: [] }]]);
    const sel = selectCampaignsToAnalyze(units, last, {
      policy: "deep_periodic_incremental",
      materialChangePct: 15,
      isDeepRun: true,
      topN: 5,
    });
    expect(sel.toAnalyze.map((u) => u.campaign.id).sort()).toEqual(["C1", "C2"]);
    expect(sel.toInherit).toHaveLength(0);
  });
});
