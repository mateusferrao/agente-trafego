import { describe, expect, it } from "vitest";
import type { AccountBrief, CampaignUnit, EntitySummary } from "@trafego/shared";
import type { AnalysisOutput } from "@trafego/shared/schemas";
import type { LLMMessage } from "@trafego/shared/ports";
import { GROUNDING_RULE, FINDINGS_METRIC_INSTRUCTION, buildCampaignMessages, buildReviewMessages, buildSynthesisMessages } from "./prompt.js";

const systemOf = (messages: readonly LLMMessage[]): string => messages[0]!.content as string;

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

function campaignUnit(): CampaignUnit {
  return { campaign: entity(), adsets: [] };
}

describe("buildCampaignMessages (S0b — kernel de conhecimento condicionado por relevância)", () => {
  it("system carrega GROUNDING_RULE + FINDINGS_METRIC_INSTRUCTION + os blocos-base + advice (papel map)", () => {
    const system = systemOf(buildCampaignMessages("persona", campaignUnit(), new Map(), { currency: "BRL", window: "7d" }));
    expect(system).toContain(GROUNDING_RULE);
    expect(system).toContain(FINDINGS_METRIC_INSTRUCTION);
    expect(system).toContain("conversionBasis"); // mismatch
    expect(system).toContain("Copy real"); // advice — só no papel map
  });

  it("NUNCA inclui os blocos de conta (waste/tracking são desperdício/tracking — não computados por campanha)", () => {
    const system = systemOf(buildCampaignMessages("persona", campaignUnit(), new Map(), { currency: "BRL", window: "7d" }));
    expect(system).not.toContain("money shot");
    expect(system).not.toContain("trackingHealth");
  });

  it("sem revenue/benchmarkRef na campanha: omite os blocos condicionais (integração ponta-a-ponta)", () => {
    const system = systemOf(buildCampaignMessages("persona", campaignUnit(), new Map(), { currency: "BRL", window: "7d" }));
    expect(system).not.toContain("receita rastreada TOTAL");
    expect(system).not.toContain("benchmarkRef");
  });

  it("com revenue na campanha: inclui o bloco de receita rastreada (integração ponta-a-ponta)", () => {
    const unit = campaignUnit();
    const withRevenue = { ...unit, campaign: entity({ metrics: { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1, revenue: 500 } }) };
    const system = systemOf(buildCampaignMessages("persona", withRevenue, new Map(), { currency: "BRL", window: "7d" }));
    expect(system).toContain("receita rastreada TOTAL");
  });

  it("com benchmarkRef na campanha: inclui o bloco de referência de plataforma (integração ponta-a-ponta)", () => {
    const unit = campaignUnit();
    const withBenchmark = { ...unit, campaign: entity({ benchmarkRef: { coldStart: true } }) };
    const system = systemOf(buildCampaignMessages("persona", withBenchmark, new Map(), { currency: "BRL", window: "7d" }));
    expect(system).toContain("benchmarkRef");
  });
});

describe("buildSynthesisMessages (S0b)", () => {
  it("sem waste/tracking real: não injeta os blocos condicionais (prompt não infla à toa)", () => {
    const system = systemOf(buildSynthesisMessages("persona", brief(), []));
    expect(system).not.toContain("money shot");
    expect(system).not.toContain("trackingHealth");
    expect(system).not.toContain("Copy real"); // advice é só do papel map
  });

  it("com waste REAL (zumbi com gasto): injeta o bloco de desperdício", () => {
    const b = brief({ waste: { totalSpend: 100, wastedSpend: 40, wastedPct: 40, zombies: [{ id: "z", name: "Zumbi", spend: 40 }] } });
    const system = systemOf(buildSynthesisMessages("persona", b, []));
    expect(system).toContain("money shot");
  });

  it("com tracking suspeito: injeta o bloco de honestidade de tracking", () => {
    const b = brief({ trackingHealth: { suspect: true, funnelStarted: 100, trackedConversions: 1, ratio: 100 } });
    const system = systemOf(buildSynthesisMessages("persona", b, []));
    expect(system).toContain("trackingHealth");
  });
});

describe("buildReviewMessages (G7 — revisor corrige contra a régua de domínio, não só número)", () => {
  it("system carrega os blocos-base de domínio (ex: incrementalidade) mas NUNCA advice/waste/tracking", () => {
    const draft: AnalysisOutput = { scorecard: { grade: "B", headline: "ok", biggestLeak: "conversao" }, summary: "s", findings: [], recommendations: [] };
    const system = systemOf(buildReviewMessages(brief(), draft, []));
    expect(system).toContain("ATRIBUÍDO"); // incrementality
    expect(system).not.toContain("Copy real"); // advice — só map
    expect(system).not.toContain("money shot"); // waste — só synthesis
  });
});

describe("perfil vertical (S4, G6) — anexado PROGRAMATICAMENTE nos 3 papéis", () => {
  it("vertical='health': map/synthesis/review carregam o raciocínio de saúde (funil real, não só CPL)", () => {
    const map = systemOf(buildCampaignMessages("persona", campaignUnit(), new Map(), { currency: "BRL", window: "7d" }, new Map(), "health"));
    const synthesis = systemOf(buildSynthesisMessages("persona", brief(), [], "health"));
    const draft: AnalysisOutput = { scorecard: { grade: "B", headline: "ok", biggestLeak: "conversao" }, summary: "s", findings: [], recommendations: [] };
    const review = systemOf(buildReviewMessages(brief(), draft, [], "health"));
    for (const system of [map, synthesis, review]) {
      expect(system.toUpperCase()).toContain("DIAGNÓSTICO");
      expect(system.toLowerCase()).toContain("fim de semana");
    }
  });

  it("vertical ausente/desconhecida: NÃO injeta raciocínio de nicho (honesto — nunca inventa perfil)", () => {
    const semVertical = systemOf(buildSynthesisMessages("persona", brief(), []));
    const desconhecida = systemOf(buildSynthesisMessages("persona", brief(), [], "automotive"));
    expect(semVertical.toLowerCase()).not.toContain("fim de semana");
    expect(desconhecida.toLowerCase()).not.toContain("fim de semana");
  });

  it("G6: o texto vertical NÃO depende do systemPrompt (persona) recebido — sobrevive a qualquer override", () => {
    const system = systemOf(buildSynthesisMessages("persona customizada e completamente diferente do padrão", brief(), [], "health"));
    expect(system.toLowerCase()).toContain("fim de semana");
  });
});
