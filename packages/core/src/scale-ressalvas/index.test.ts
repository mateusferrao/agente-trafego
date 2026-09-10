import { describe, expect, it } from "vitest";
import type { Action, DecisionEligibility, HealthSignal, RessalvaCode } from "@trafego/shared";
import { ACTION_PARAM_MODE, ACTION_PARAM_PCT, BUDGET_MODE_DECREASE, BUDGET_MODE_INCREASE } from "@trafego/shared";
import type { LessonGuard } from "../learning/index.js";
import { DEFAULT_AUDIENCE_CEILING_THRESHOLDS, DEFAULT_MARGINAL_CPA_THRESHOLDS } from "../analysis-guards/index.js";
import { type ScaleRessalvaContext, computeScaleRessalvas, isScaleAction, ressalvasFromSnapshot } from "./index.js";

const scaleBudget = (over?: Partial<Action>): Action => ({
  id: "a1",
  type: "adjust_budget",
  target: { level: "campaign", id: "C1" },
  params: { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: 20 },
  source: "llm",
  riskLevel: "medium",
  reason: "escalar",
  ...over,
});

const emptyCtx = (over?: Partial<ScaleRessalvaContext>): ScaleRessalvaContext => ({
  eligibility: new Map(),
  marginalRisePct: new Map(),
  marginal: DEFAULT_MARGINAL_CPA_THRESHOLDS,
  headroom: new Map(),
  ceiling: DEFAULT_AUDIENCE_CEILING_THRESHOLDS,
  signals: new Map(),
  lessonGuards: [],
  ...over,
});

const codes = (rs: readonly { code: RessalvaCode }[]): RessalvaCode[] => rs.map((r) => r.code);
const elig = (over: Partial<DecisionEligibility>): DecisionEligibility =>
  ({ hasSignificance: true, inLearning: false, conversions: 100, ...over }) as DecisionEligibility;

describe("isScaleAction", () => {
  it("resume_entity → escala", () => expect(isScaleAction(scaleBudget({ type: "resume_entity", params: {} }))).toBe(true));
  it("adjust_budget increase → escala", () => expect(isScaleAction(scaleBudget())).toBe(true));
  it("adjust_budget decrease → NÃO", () =>
    expect(isScaleAction(scaleBudget({ params: { [ACTION_PARAM_MODE]: BUDGET_MODE_DECREASE, [ACTION_PARAM_PCT]: 20 } }))).toBe(false));
  it("pause_entity → NÃO", () => expect(isScaleAction(scaleBudget({ type: "pause_entity", params: {} }))).toBe(false));
  it("set_status → NÃO", () => expect(isScaleAction(scaleBudget({ type: "set_status", params: { status: "PAUSED" } }))).toBe(false));
});

describe("computeScaleRessalvas", () => {
  it("ação que não é escala → nenhuma ressalva", () => {
    expect(computeScaleRessalvas(scaleBudget({ type: "pause_entity", params: {} }), emptyCtx())).toEqual([]);
  });

  it("sem contexto de risco → nenhuma ressalva (vencedor limpo escala direto)", () => {
    expect(computeScaleRessalvas(scaleBudget(), emptyCtx())).toEqual([]);
  });

  it("significância batida e fora de learning → sem ressalva", () => {
    const ctx = emptyCtx({ eligibility: new Map([["C1", elig({ hasSignificance: true, inLearning: false })]]) });
    expect(computeScaleRessalvas(scaleBudget(), ctx)).toEqual([]);
  });

  it("sem base estatística → ressalva no_significance", () => {
    const ctx = emptyCtx({ eligibility: new Map([["C1", elig({ hasSignificance: false, conversions: 3 })]]) });
    const rs = computeScaleRessalvas(scaleBudget(), ctx);
    expect(codes(rs)).toEqual(["no_significance"]);
    expect(rs[0]!.message).toContain("3");
  });

  it("em aprendizado → ressalva no_significance (mensagem de aprendizado)", () => {
    const ctx = emptyCtx({ eligibility: new Map([["C1", elig({ hasSignificance: true, inLearning: true })]]) });
    const rs = computeScaleRessalvas(scaleBudget(), ctx);
    expect(codes(rs)).toEqual(["no_significance"]);
    expect(rs[0]!.message.toLowerCase()).toContain("aprendizado");
  });

  it("CPA marginal piorando acima do limiar → ressalva worsening_marginal_cpa", () => {
    const ctx = emptyCtx({ marginalRisePct: new Map([["C1", 45]]) });
    expect(codes(computeScaleRessalvas(scaleBudget(), ctx))).toEqual(["worsening_marginal_cpa"]);
  });

  it("CPA marginal abaixo do limiar → sem ressalva", () => {
    const ctx = emptyCtx({ marginalRisePct: new Map([["C1", 5]]) });
    expect(computeScaleRessalvas(scaleBudget(), ctx)).toEqual([]);
  });

  it("limiar de CPA marginal malformado → não penaliza", () => {
    const ctx = emptyCtx({ marginalRisePct: new Map([["C1", 99]]), marginal: { worsenPct: 0 } });
    expect(computeScaleRessalvas(scaleBudget(), ctx)).toEqual([]);
  });

  it("público perto do teto → ressalva audience_ceiling", () => {
    const ctx = emptyCtx({ headroom: new Map([["C1", { monthlyReach: 10000, currentMonthlyImpressions: 90000, frequencyCap: 10 }]]) });
    expect(codes(computeScaleRessalvas(scaleBudget(), ctx))).toEqual(["audience_ceiling"]);
  });

  it("público com folga → sem ressalva", () => {
    const ctx = emptyCtx({ headroom: new Map([["C1", { monthlyReach: 10000, currentMonthlyImpressions: 10000, frequencyCap: 10 }]]) });
    expect(computeScaleRessalvas(scaleBudget(), ctx)).toEqual([]);
  });

  it("alcance mensal desconhecido → passa (sem dado, não assume saturado)", () => {
    const ctx = emptyCtx({ headroom: new Map([["C1", { currentMonthlyImpressions: 90000, frequencyCap: 10 }]]) });
    expect(computeScaleRessalvas(scaleBudget(), ctx)).toEqual([]);
  });

  it("fadiga de criativo → ressalva creative_fatigue (com o sinal)", () => {
    const signals = new Map<string, readonly HealthSignal[]>([["C1", ["weak_hook_retention"]]]);
    const rs = computeScaleRessalvas(scaleBudget(), emptyCtx({ signals }));
    expect(codes(rs)).toEqual(["creative_fatigue"]);
    expect(rs[0]!.message).toContain("weak_hook_retention");
  });

  it("desgaste AGING → mesma ressalva (trava escala) mas mensagem de 'prepare o sucessor', não 'renove já'", () => {
    const signals = new Map<string, readonly HealthSignal[]>([["C1", ["creative_aging"]]]);
    const rs = computeScaleRessalvas(scaleBudget(), emptyCtx({ signals }));
    expect(codes(rs)).toEqual(["creative_fatigue"]); // código igual: a trava de auto-apply é a mesma
    expect(rs[0]!.message).toContain("ainda entrega");
    expect(rs[0]!.message).toContain("próximo criativo");
  });

  it("hipótese não-confirmada nível-conta → ressalva unconfirmed_hypothesis", () => {
    const g: LessonGuard = { key: { direction: "lower", scope: "account", subjectId: null } } as unknown as LessonGuard;
    expect(codes(computeScaleRessalvas(scaleBudget(), emptyCtx({ lessonGuards: [g] })))).toEqual(["unconfirmed_hypothesis"]);
  });

  it("hipótese de OUTRA entidade → não afeta esta", () => {
    const g: LessonGuard = { key: { direction: "lower", scope: "entity", subjectId: "C2" } } as unknown as LessonGuard;
    expect(computeScaleRessalvas(scaleBudget(), emptyCtx({ lessonGuards: [g] }))).toEqual([]);
  });

  it("acumula múltiplos sinais numa mesma ação", () => {
    const ctx = emptyCtx({
      eligibility: new Map([["C1", elig({ hasSignificance: false, conversions: 2 })]]),
      signals: new Map<string, readonly HealthSignal[]>([["C1", ["creative_fatigue"]]]),
    });
    expect(codes(computeScaleRessalvas(scaleBudget(), ctx))).toEqual(["no_significance", "creative_fatigue"]);
  });
});

describe("ressalvasFromSnapshot (on-demand — a partir do snapshot persistido)", () => {
  it("vencedor fatigado no snapshot → ressalva creative_fatigue (fim da escala contraditória on-demand)", () => {
    const rs = ressalvasFromSnapshot(scaleBudget(), { healthSignals: ["creative_fatigue"] });
    expect(codes(rs)).toContain("creative_fatigue");
  });
  it("sem significância no snapshot → ressalva no_significance", () => {
    const rs = ressalvasFromSnapshot(scaleBudget(), { eligibility: elig({ hasSignificance: false, conversions: 3 }) });
    expect(codes(rs)).toContain("no_significance");
  });
  it("snapshot limpo → sem ressalva; snapshot ausente → vazio; ação não-escala → vazio", () => {
    expect(ressalvasFromSnapshot(scaleBudget(), { eligibility: elig({}), healthSignals: [] })).toEqual([]);
    expect(ressalvasFromSnapshot(scaleBudget(), null)).toEqual([]);
    expect(ressalvasFromSnapshot(scaleBudget({ type: "pause_entity", params: {} }), { healthSignals: ["creative_fatigue"] })).toEqual([]);
  });
  it("CBO: chaveia pelo action.target.id (campanha-mãe), não pelo id do vencedor — ressalva NÃO some", () => {
    // vencedor é o adset, mas a ação de subir orçamento mira a CAMPANHA-mãe (target.id = CAMP).
    const cboAction = scaleBudget({ target: { level: "campaign", id: "CAMP" } });
    const rs = ressalvasFromSnapshot(cboAction, { healthSignals: ["creative_fatigue"] });
    expect(codes(rs)).toContain("creative_fatigue");
  });
});
