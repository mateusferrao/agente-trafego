import { describe, expect, it } from "vitest";
import type { AccountBrief, CampaignUnit, EntitySummary } from "@trafego/shared";
import {
  ANALYSIS_KNOWLEDGE_BLOCKS,
  REVIEW_KNOWLEDGE_CONTEXT,
  THEME_ORDER,
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

  it("hasBudgetData: true quando alguma entidade traz budget OU atBudgetCeiling", () => {
    expect(
      buildSynthesisKnowledgeContext(brief({ segments: { campaigns: [entity({ budget: { dailyMajor: 100 } })], adsets: [], ads: [] } })).hasBudgetData,
    ).toBe(true);
    expect(
      buildSynthesisKnowledgeContext(brief({ segments: { campaigns: [entity({ atBudgetCeiling: false })], adsets: [], ads: [] } })).hasBudgetData,
    ).toBe(true);
    expect(buildSynthesisKnowledgeContext(brief()).hasBudgetData).toBe(false);
  });

  it("bidStrategyMismatch: true quando há estratégia agressiva E a conta NÃO tem conversões de negócio acumuladas suficientes", () => {
    const b = brief({
      segments: {
        campaigns: [entity({ bidStrategy: "bid_cap", conversionBasis: "target", metrics: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, conversions: 10 } })],
        adsets: [],
        ads: [],
      },
    });
    expect(buildSynthesisKnowledgeContext(b).bidStrategyMismatch).toBe(true);
  });
  it("bidStrategyMismatch: false quando a conta JÁ tem conversões de negócio acumuladas suficientes (soma entre campanhas)", () => {
    const b = brief({
      segments: {
        campaigns: [
          entity({ id: "c1", bidStrategy: "bid_cap", conversionBasis: "target", metrics: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, conversions: 30 } }),
          entity({ id: "c2", conversionBasis: "target", metrics: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, conversions: 25 } }),
        ],
        adsets: [],
        ads: [],
      },
    });
    expect(buildSynthesisKnowledgeContext(b).bidStrategyMismatch).toBe(false);
  });
  it("bidStrategyMismatch: false quando toda entidade usa lowest_cost (padrão esperado)", () => {
    const b = brief({ segments: { campaigns: [entity({ bidStrategy: "lowest_cost" })], adsets: [], ads: [] } });
    expect(buildSynthesisKnowledgeContext(b).bidStrategyMismatch).toBe(false);
  });

  it("REGRESSÃO (achado da revisão): conta ZERO-CONFIG (totals.conversions sempre undefined, sem goals.conversionGoal) com conversões REAIS na campanha não dispara o guard indevidamente", () => {
    const b = brief({
      // totals.conversions fica ausente em zero-config (resolveConversion exige override
      // ou objetivo de entidade — conta não tem objetivo próprio) — o campo NÃO é setado
      // de propósito aqui, simulando o `computeAccountTotals` real numa conta zero-config.
      segments: {
        campaigns: [entity({ bidStrategy: "bid_cap", conversionBasis: "target", metrics: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, conversions: 80 } })],
        adsets: [],
        ads: [],
      },
    });
    expect(b.totals.conversions).toBeUndefined();
    expect(buildSynthesisKnowledgeContext(b).bidStrategyMismatch).toBe(false);
  });

  it("ignora conversões de entidades com conversionBasis 'proxy'/'none' (não é a conversão de NEGÓCIO)", () => {
    const b = brief({
      segments: {
        campaigns: [entity({ bidStrategy: "bid_cap", conversionBasis: "proxy", metrics: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, conversions: 500 } })],
        adsets: [],
        ads: [],
      },
    });
    // 500 conversas (proxy) não contam como maturidade de conversão de NEGÓCIO.
    expect(buildSynthesisKnowledgeContext(b).bidStrategyMismatch).toBe(true);
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

  it("hasBudgetData: true quando a campanha (CBO) ou algum adset (ABO) tem budget", () => {
    expect(buildCampaignKnowledgeContext(campaignUnit(entity({ budget: { dailyMajor: 50 } }))).hasBudgetData).toBe(true);
    expect(buildCampaignKnowledgeContext(campaignUnit(entity())).hasBudgetData).toBe(false);
  });
});

describe("selectAnalysisKnowledge — relevância por papel e por dado", () => {
  const baseSynthesisCtx = { role: "synthesis" as const, hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: false, bidStrategyMismatch: false };

  it("synthesis sem waste/tracking/revenue/benchmark/budget/bid_strategy: só os blocos-base de domínio (nunca inventa relevância)", () => {
    const keys = selectAnalysisKnowledge(baseSynthesisCtx).map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(["funnel", "mismatch", "quality", "incrementality", "recency", "diagnosis"]));
    expect(keys).not.toContain("waste");
    expect(keys).not.toContain("tracking");
    expect(keys).not.toContain("revenue");
    expect(keys).not.toContain("benchmark");
    expect(keys).not.toContain("budget");
    expect(keys).not.toContain("bid_strategy");
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
  it("synthesis com dado de budget → inclui o bloco budget", () => {
    expect(selectAnalysisKnowledge({ ...baseSynthesisCtx, hasBudgetData: true }).map((b) => b.key)).toContain("budget");
  });
  it("map com dado de budget → TAMBÉM inclui o bloco budget (útil por-campanha, não só conta)", () => {
    expect(
      selectAnalysisKnowledge({ role: "map", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: true, bidStrategyMismatch: false }).map(
        (b) => b.key,
      ),
    ).toContain("budget");
  });
  it("synthesis com bidStrategyMismatch → inclui o bloco bid_strategy", () => {
    expect(selectAnalysisKnowledge({ ...baseSynthesisCtx, bidStrategyMismatch: true }).map((b) => b.key)).toContain("bid_strategy");
  });
  it("map NUNCA inclui bid_strategy (é sinal de CONTA — maturidade de dado agregada)", () => {
    expect(
      selectAnalysisKnowledge({ role: "map", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: false, bidStrategyMismatch: true }).map(
        (b) => b.key,
      ),
    ).not.toContain("bid_strategy");
  });

  it("map SEMPRE inclui advice (direção de criativo/público), nunca waste/tracking mesmo se o ctx mentir", () => {
    const keys = selectAnalysisKnowledge({ role: "map", hasWaste: true, trackingSuspect: true, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: false, bidStrategyMismatch: false }).map(
      (b) => b.key,
    );
    expect(keys).toContain("advice");
    expect(keys).not.toContain("waste");
    expect(keys).not.toContain("tracking");
  });

  it("review: só os blocos-base de domínio (G7) — nunca advice/waste/tracking/revenue/benchmark/budget/bid_strategy", () => {
    const keys = selectAnalysisKnowledge(REVIEW_KNOWLEDGE_CONTEXT).map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(["funnel", "mismatch", "quality", "incrementality", "recency", "diagnosis"]));
    expect(keys).not.toContain("advice");
    expect(keys).not.toContain("waste");
    expect(keys).not.toContain("tracking");
    expect(keys).not.toContain("revenue");
    expect(keys).not.toContain("benchmark");
    expect(keys).not.toContain("budget");
    expect(keys).not.toContain("bid_strategy");
  });
});

describe("buildAnalysisKnowledgeText — montagem agrupada por tema, ordem estável", () => {
  it("agrupa por tema com o mesmo texto das notas originais, e a seção 'conversão' vem antes de 'qualidade', que vem antes de 'desperdício', que vem antes de 'orçamento'", () => {
    const text = buildAnalysisKnowledgeText({ role: "synthesis", hasWaste: true, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: true, bidStrategyMismatch: false });
    expect(text.indexOf("Conversão")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Conversão")).toBeLessThan(text.indexOf("Qualidade"));
    expect(text.indexOf("Qualidade")).toBeLessThan(text.indexOf("Desperdício"));
    expect(text.indexOf("Desperdício")).toBeLessThan(text.indexOf("Orçamento"));
  });

  it("não injeta o tema desperdício quando nenhum bloco dele é relevante", () => {
    const text = buildAnalysisKnowledgeText({ role: "map", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: false, bidStrategyMismatch: false });
    expect(text).not.toContain("Desperdício");
  });

  it("não injeta o tema orçamento quando não há dado de budget nem descasamento de lance", () => {
    const text = buildAnalysisKnowledgeText({ role: "synthesis", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: false, bidStrategyMismatch: false });
    expect(text).not.toContain("Orçamento");
  });

  it("bloco de orçamento cita CBO×ABO e CPA marginal + faseamento (decisão 4 do plano)", () => {
    const text = buildAnalysisKnowledgeText({ role: "synthesis", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: true, bidStrategyMismatch: false });
    expect(text).toContain("isCBO");
    expect(text.toUpperCase()).toContain("FASES");
    expect(text.toUpperCase()).toContain("MARGINAL");
  });

  it("bloco de qualidade cita weak_creative (S4b) e orienta testar variação, não pausar winner", () => {
    const text = buildAnalysisKnowledgeText({ role: "synthesis", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: false, bidStrategyMismatch: false });
    expect(text).toContain("weak_creative");
    expect(text.toLowerCase()).toContain("testar");
  });

  it("bloco de bid strategy cita lowest_cost como padrão e ~50 conversões como maturidade (decisão 13)", () => {
    const text = buildAnalysisKnowledgeText({ role: "synthesis", hasWaste: false, trackingSuspect: false, hasRevenue: false, hasBenchmarkRef: false, hasBudgetData: false, bidStrategyMismatch: true });
    expect(text).toContain("lowest_cost");
    expect(text).toContain("50");
  });
});

describe("invariante — todo tema usado em ANALYSIS_KNOWLEDGE_BLOCKS está em THEME_ORDER (achado da revisão)", () => {
  it("nenhum bloco tem tema fora de THEME_ORDER (senão o bloco nunca sairia no texto, mesmo com relevant()=true)", () => {
    const usedThemes = new Set(ANALYSIS_KNOWLEDGE_BLOCKS.map((b) => b.theme));
    for (const theme of usedThemes) {
      expect(THEME_ORDER).toContain(theme);
    }
  });
});
