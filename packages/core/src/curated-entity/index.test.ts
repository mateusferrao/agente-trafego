import { describe, expect, it } from "vitest";
import type { EntitySummary } from "@trafego/shared";
import { buildCuratedEntitySnapshot, campaignsAtBudgetCeiling } from "./index.js";

function entity(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: "c1",
    level: "campaign",
    name: "Campanha X",
    status: "active",
    metrics: { spend: 100, impressions: 1000, clicks: 50, ctr: 5, cpc: 2, cpm: 100 },
    deltaVsBaseline: {},
    flags: [],
    ...overrides,
  };
}

describe("buildCuratedEntitySnapshot (S1 — persistência do que o chat/redator precisam ver)", () => {
  it("isCBO=true quando a entidade tem budget PRÓPRIO (CBO)", () => {
    const snap = buildCuratedEntitySnapshot(entity({ budget: { dailyMajor: 100 }, atBudgetCeiling: true }));
    expect(snap.isCBO).toBe(true);
    expect(snap.budget).toEqual({ dailyMajor: 100 });
    expect(snap.atBudgetCeiling).toBe(true);
  });

  it("isCBO=false quando a entidade NÃO tem budget próprio (ABO — vive nos adsets)", () => {
    const snap = buildCuratedEntitySnapshot(entity());
    expect(snap.isCBO).toBe(false);
    expect(snap.budget).toBeUndefined();
  });

  it("carrega tier/conversionBasis/healthSignals/eligibility quando presentes", () => {
    const snap = buildCuratedEntitySnapshot(
      entity({
        tier: "winner",
        conversionBasis: "proxy",
        healthSignals: ["creative_fatigue"],
        eligibility: { hasSignificance: true, inLearning: false, conversions: 30, clicks: 200 },
      }),
    );
    expect(snap.tier).toBe("winner");
    expect(snap.conversionBasis).toBe("proxy");
    expect(snap.healthSignals).toEqual(["creative_fatigue"]);
    expect(snap.eligibility).toEqual({ hasSignificance: true, inLearning: false, conversions: 30, clicks: 200 });
  });

  it("omite healthSignals quando array vazio (não polui o snapshot com [])", () => {
    const snap = buildCuratedEntitySnapshot(entity({ healthSignals: [] }));
    expect(snap.healthSignals).toBeUndefined();
  });

  it("carrega campaignId quando presente (S8 — liga o adset de volta à campanha-mãe ABO)", () => {
    const snap = buildCuratedEntitySnapshot(entity({ campaignId: "c1" }));
    expect(snap.campaignId).toBe("c1");
  });

  it("carrega benchmarkRef quando presente (S8 — cold-start visível no chat/redator)", () => {
    const snap = buildCuratedEntitySnapshot(entity({ benchmarkRef: { coldStart: true, ctrRating: "ok" } }));
    expect(snap.benchmarkRef).toEqual({ coldStart: true, ctrRating: "ok" });
  });

  it("carrega audience/funnel quando presentes", () => {
    const snap = buildCuratedEntitySnapshot(
      entity({
        audience: { stage: "remarketing", customAudienceCount: 1, exclusionCount: 0, expansion: { summary: "off" } },
        funnel: { counts: { conversation_started: 10 }, replyRate: 0.5 },
      }),
    );
    expect(snap.audience?.stage).toBe("remarketing");
    expect(snap.funnel?.counts.conversation_started).toBe(10);
  });

  it("entidade mínima (sem nenhum campo opcional): só isCBO=false, resto omitido", () => {
    const snap = buildCuratedEntitySnapshot(entity());
    expect(snap).toEqual({ isCBO: false });
  });
});

describe("campaignsAtBudgetCeiling (S1 — redator lidera por orçamento sem folga)", () => {
  it("nomes das campanhas ATIVAS com atBudgetCeiling=true, ignora false/ausente", () => {
    const names = campaignsAtBudgetCeiling([
      entity({ id: "c1", name: "No teto", atBudgetCeiling: true }),
      entity({ id: "c2", name: "Com folga", atBudgetCeiling: false }),
      entity({ id: "c3", name: "Sem dado" }),
    ]);
    expect(names).toEqual(["No teto"]);
  });

  it("ignora campanha PAUSADA no teto (não é ação a liderar)", () => {
    const names = campaignsAtBudgetCeiling([entity({ id: "c1", name: "Pausada no teto", status: "paused", atBudgetCeiling: true })]);
    expect(names).toEqual([]);
  });

  it("cap no nº máximo (default 3) — não lista todas se forem muitas", () => {
    const many = Array.from({ length: 5 }, (_, i) => entity({ id: `c${i}`, name: `Campanha ${i}`, atBudgetCeiling: true }));
    expect(campaignsAtBudgetCeiling(many)).toHaveLength(3);
    expect(campaignsAtBudgetCeiling(many, 2)).toHaveLength(2);
  });
});
