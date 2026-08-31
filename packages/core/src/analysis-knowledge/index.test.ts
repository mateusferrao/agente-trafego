import { describe, expect, it } from "vitest";
import type { AccountBrief, CampaignUnit, EntitySummary } from "@trafego/shared";
import {
  REVIEW_KNOWLEDGE_CONTEXT,
  buildAnalysisKnowledgeText,
  buildCampaignKnowledgeContext,
  buildSynthesisKnowledgeContext,
  selectAnalysisKnowledge,
} from "./index.js";

function entity(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: overrides.id ?? "e-1",
    level: overrides.level ?? "campaign",
    name: overrides.name ?? "Campanha X",
    status: overrides.status ?? "active",
    metrics: { spend: 100, impressions: 1000, clicks: 50, ctr: 5, cpc: 2, cpm: 100, ...overrides.metrics },
    deltaVsBaseline: {},
    flags: [],
    ...overrides,
  };
}

function brief(overrides: Partial<AccountBrief> = {}): AccountBrief {
  return {
    account: { id: "acc-1", name: "Conta", currency: "BRL", window: "7d", baselineWindow: "7d" },
    goals: {},
    totals: { spend: 100, impressions: 1000, clicks: 50, ctr: 5, cpc: 2, cpm: 100, delta: {} } as AccountBrief["totals"],
    trends: [],
    segments: { campaigns: [], adsets: [], ads: [] },
    anomalies: [],
    creatives: [],
    playbookCandidates: [],
    memory: { objectives: [], pastActions: [], rejected: [] },
    aggregatesRest: { count: 0, spend: 0 },
    ...overrides,
  };
}

function campaignUnit(campaign: EntitySummary, notableAds: readonly EntitySummary[] = []): CampaignUnit {
  return {
    campaign,
    adsets: notableAds.length > 0 ? [{ adset: entity({ id: "as-1", level: "adset" }), notableAds, tail: { count: 0, spend: 0, allWithinTarget: true } }] : [],
  };
}

describe("buildSynthesisKnowledgeContext", () => {
  it("hasWaste: false quando o WasteReport não tem zumbi nem má alocação", () => {
    const b = brief({ waste: { totalSpend: 100, wastedSpend: 0, wastedPct: 0, zombies: [] } });
    expect(buildSynthesisKnowledgeContext(b).hasWaste).toBe(false);
  });
  it("hasWaste: true quando há gasto zumbi", () => {
    const b = brief({ waste: { totalSpend: 100, wastedSpend: 30, wastedPct: 30, zombies: [{ id: "z", name: "Zumbi", spend: 30 }] } });
    expect(buildSynthesisKnowledgeContext(b).hasWaste).toBe(true);
  });
  it("hasWaste: true quando há má alocação no pareto (mesmo sem zumbi)", () => {
    const b = brief({
      waste: {
        totalSpend: 100,
        wastedSpend: 0,
        wastedPct: 0,
        zombies: [],
        pareto: { basis: "target", groupSpend: 100, items: [], misallocated: [{ id: "m", name: "Mal alocada", spend: 80, spendPct: 80 }] },
      },
    });
    expect(buildSynthesisKnowledgeContext(b).hasWaste).toBe(true);
  });

  it("trackingSuspect reflete trackingHealth.suspect", () => {
    expect(buildSynthesisKnowledgeContext(brief({ trackingHealth: { suspect: true, funnelStarted: 50, trackedConversions: 1, ratio: 50 } })).trackingSuspect).toBe(true);
    expect(buildSynthesisKnowledgeContext(brief()).trackingSuspect).toBe(false);
  });

  it("hasRevenue: true por totals.revenue OU por revenue em alguma entidade", () => {
    expect(
      buildSynthesisKnowledgeContext(brief({ totals: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, revenue: 500, delta: {} } as AccountBrief["totals"] }))
        .hasRevenue,
    ).toBe(true);
    expect(
      buildSynthesisKnowledgeContext(brief({ segments: { campaigns: [entity({ metrics: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, revenue: 200 } })], adsets: [], ads: [] } }))
        .hasRevenue,
    ).toBe(true);
    expect(buildSynthesisKnowledgeContext(brief()).hasRevenue).toBe(false);
  });

  it("hasBenchmarkRef: true quando alguma entidade traz benchmarkRef", () => {
    expect(
      buildSynthesisKnowledgeContext(
        brief({ segments: { campaigns: [entity({ benchmarkRef: { coldStart: true } })], adsets: [], ads: [] } }),
      ).hasBenchmarkRef,
    ).toBe(true);
    expect(buildSynthesisKnowledgeContext(brief()).hasBenchmarkRef).toBe(false);
  });
});

describe("buildCampaignKnowledgeContext (map)", () => {
  it("role='map' e hasWaste/trackingSuspect SEMPRE false (conta-level, não computado por campanha)", () => {
    const ctx = buildCampaignKnowledgeContext(campaignUnit(entity()));
    expect(ctx.role).toBe("map");
    expect(ctx.hasWaste).toBe(false);
    expect(ctx.trackingSuspect).toBe(false);
  });

  it("hasRevenue/hasBenchmarkRef derivados dos anúncios notáveis da unidade", () => {
    const withRevenue = campaignUnit(entity(), [entity({ id: "ad-1", level: "ad", metrics: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, revenue: 10 } })]);
    expect(buildCampaignKnowledgeContext(withRevenue).hasRevenue).toBe(true);
    expect(buildCampaignKnowledgeContext(campaignUnit(entity())).hasRevenue).toBe(false);
  });
});

describe("selectAnalysisKnowledge — relevância por papel e por dado", () => {
  const baseSynthesisCtx = { role: "synthesis" as const, hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false };

  it("synthesis sem waste/tracking/revenue/benchmark: só os blocos-base de domínio (nunca inventa relevância)", () => {
    const keys = selectAnalysisKnowledge(baseSynthesisCtx).map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(["funnel", "mismatch", "quality", "incrementality", "recency", "diagnosis"]));
    expect(keys).not.toContain("waste");
    expect(keys).not.toContain("tracking");
    expect(keys).not.toContain("revenue");
    expect(keys).not.toContain("benchmark");
    expect(keys).not.toContain("advice"); // advice é só do papel "map"
  });

  it("synthesis com waste real → inclui o bloco waste", () => {
    expect(selectAnalysisKnowledge({ ...baseSynthesisCtx, hasWaste: true }).map((b) => b.key)).toContain("waste");
  });
  it("synthesis com tracking suspeito → inclui o bloco tracking", () => {
    expect(selectAnalysisKnowledge({ ...baseSynthesisCtx, trackingSuspect: true }).map((b) => b.key)).toContain("tracking");
  });
  it("synthesis com revenue → inclui o bloco revenue", () => {
    expect(selectAnalysisKnowledge({ ...baseSynthesisCtx, hasRevenue: true }).map((b) => b.key)).toContain("revenue");
  });
  it("synthesis com benchmarkRef → inclui o bloco benchmark", () => {
    expect(selectAnalysisKnowledge({ ...baseSynthesisCtx, hasBenchmarkRef: true }).map((b) => b.key)).toContain("benchmark");
  });

  it("map SEMPRE inclui advice (direção de criativo/público), nunca waste/tracking mesmo se o ctx mentir", () => {
    const keys = selectAnalysisKnowledge({ role: "map", hasWaste: true, trackingSuspect: true, hasRevenue: false, hasBenchmarkRef: false }).map((b) => b.key);
    expect(keys).toContain("advice");
    expect(keys).not.toContain("waste");
    expect(keys).not.toContain("tracking");
  });

  it("review: só os blocos-base de domínio (G7) — nunca advice/waste/tracking/revenue/benchmark", () => {
    const keys = selectAnalysisKnowledge(REVIEW_KNOWLEDGE_CONTEXT).map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(["funnel", "mismatch", "quality", "incrementality", "recency", "diagnosis"]));
    expect(keys).not.toContain("advice");
    expect(keys).not.toContain("waste");
    expect(keys).not.toContain("tracking");
    expect(keys).not.toContain("revenue");
    expect(keys).not.toContain("benchmark");
  });
});

describe("buildAnalysisKnowledgeText — montagem agrupada por tema, ordem estável", () => {
  it("agrupa por tema com o mesmo texto das notas originais, e a seção 'conversão' vem antes de 'qualidade'", () => {
    const text = buildAnalysisKnowledgeText({ role: "synthesis", hasWaste: true, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false });
    expect(text.indexOf("Conversão")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Conversão")).toBeLessThan(text.indexOf("Qualidade"));
    expect(text.indexOf("Qualidade")).toBeLessThan(text.indexOf("Desperdício"));
  });

  it("não injeta o tema desperdício quando nenhum bloco dele é relevante", () => {
    const text = buildAnalysisKnowledgeText({ role: "map", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false });
    expect(text).not.toContain("Desperdício");
  });
});
