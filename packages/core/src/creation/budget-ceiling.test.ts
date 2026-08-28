import { describe, expect, it } from "vitest";
import type { EntitySummary } from "@trafego/shared";
import { attachBudgetCeiling } from "./budget-ceiling.js";

const BASE_METRICS = { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0 };

function campaign(over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: "c1",
    level: "campaign",
    name: "Campanha",
    status: "active",
    metrics: { ...BASE_METRICS },
    deltaVsBaseline: {},
    flags: [],
    ...over,
  };
}

function adset(over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: "as1",
    level: "adset",
    name: "Adset",
    status: "active",
    metrics: { ...BASE_METRICS },
    deltaVsBaseline: {},
    flags: [],
    campaignId: "c1",
    ...over,
  };
}

const WINDOW_DAYS = 7;

describe("attachBudgetCeiling", () => {
  it("CBO diário: gasto médio/dia perto do budget diário → true", () => {
    const c = campaign({ budget: { dailyMajor: 100 }, metrics: { ...BASE_METRICS, spend: 700 } }); // 100/dia = budget
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBe(true);
  });

  it("CBO diário: gasto médio/dia bem abaixo do budget → false (folga)", () => {
    const c = campaign({ budget: { dailyMajor: 1000 }, metrics: { ...BASE_METRICS, spend: 350 } }); // 50/dia vs 1000
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBe(false);
  });

  it("CBO vitalício: budget_remaining baixo (Meta já contabiliza) → true, SEM pacing por data", () => {
    const c = campaign({ budget: { lifetimeMajor: 1000, lifetimeRemainingMajor: 50 } }); // 5% restante
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBe(true);
  });

  it("CBO vitalício: budget_remaining alto → false", () => {
    const c = campaign({ budget: { lifetimeMajor: 1000, lifetimeRemainingMajor: 800 } }); // 80% restante
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBe(false);
  });

  it("ABO: campanha SEM budget próprio agrega os adsets ATIVOS filhos (diário)", () => {
    const c = campaign();
    const a1 = adset({ id: "as1", budget: { dailyMajor: 50 }, metrics: { ...BASE_METRICS, spend: 245 } }); // 35/dia
    const a2 = adset({ id: "as2", budget: { dailyMajor: 50 }, metrics: { ...BASE_METRICS, spend: 245 } }); // 35/dia
    // total budget 100/dia, gasto médio total 70/dia → 70% (abaixo do limiar default) → false
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [a1, a2], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBe(false);
  });

  it("ABO: soma dos filhos no teto → true", () => {
    const c = campaign();
    const a1 = adset({ id: "as1", budget: { dailyMajor: 50 }, metrics: { ...BASE_METRICS, spend: 350 } }); // 50/dia
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [a1], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBe(true);
  });

  it("ABO: adset PAUSADO (não ativo) não entra na agregação", () => {
    const c = campaign();
    const a1 = adset({ id: "as1", status: "paused", budget: { dailyMajor: 1000 }, metrics: { ...BASE_METRICS, spend: 7000 } });
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [a1], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBeUndefined(); // nenhum adset ATIVO contribuiu → sem dado
  });

  it("sem NENHUM dado de budget (nem próprio, nem ABO) → undefined (honesto, não bloqueia a proposta)", () => {
    const c = campaign();
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBeUndefined();
  });

  it("vitalício tem prioridade sobre diário quando os dois estão presentes", () => {
    // budget diário sugeriria "no teto" (gasto = budget/dia), mas o vitalício (mais preciso,
    // contabilizado pela própria Meta) diz que há MUITA folga → vitalício vence.
    const c = campaign({
      budget: { dailyMajor: 100, lifetimeMajor: 5000, lifetimeRemainingMajor: 4500 },
      metrics: { ...BASE_METRICS, spend: 700 },
    });
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS });
    expect(out?.atBudgetCeiling).toBe(false);
  });

  it("windowDays=0 (defensivo) → não divide por zero, cai pra undefined se só houver daily", () => {
    const c = campaign({ budget: { dailyMajor: 100 }, metrics: { ...BASE_METRICS, spend: 700 } });
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: 0 });
    expect(out?.atBudgetCeiling).toBeUndefined();
  });

  it("limiares customizáveis (override por-agente, padrão 6c)", () => {
    const c = campaign({ budget: { dailyMajor: 100 }, metrics: { ...BASE_METRICS, spend: 560 } }); // 80/dia = 80%
    const strict = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS, thresholds: { dailySpendPct: 90 } });
    const loose = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS, thresholds: { dailySpendPct: 70 } });
    expect(strict[0]?.atBudgetCeiling).toBe(false); // 80% < 90%
    expect(loose[0]?.atBudgetCeiling).toBe(true); // 80% >= 70%
  });

  it("preserva as outras campanhas/campos intactos (não é destrutivo)", () => {
    const c = campaign({ id: "c9", name: "Outra", tier: "winner" });
    const [out] = attachBudgetCeiling({ campaigns: [c], adsets: [], windowDays: WINDOW_DAYS });
    expect(out?.id).toBe("c9");
    expect(out?.tier).toBe("winner");
  });
});
