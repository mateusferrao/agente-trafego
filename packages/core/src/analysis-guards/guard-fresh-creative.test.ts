import { describe, expect, it } from "vitest";
import type { AnalysisOutput, HealthSignal } from "@trafego/shared";
import { guardScaleWithoutFreshCreative } from "./index.js";

const rec = (over: Partial<AnalysisOutput["recommendations"][number]>): AnalysisOutput["recommendations"][number] => ({
  id: "r1",
  title: "t",
  rationale: "porque sim",
  priority: "high",
  actionType: "increase_budget",
  targetEntity: { level: "campaign", externalId: "C1" },
  budgetChangePct: 20,
  expectedImpact: null,
  whatToMonitor: null,
  findingRefs: null,
  ...over,
});

const output = (recs: AnalysisOutput["recommendations"]): AnalysisOutput => ({
  scorecard: { grade: "B", headline: "h", biggestLeak: "conversao" },
  summary: "s",
  findings: [],
  recommendations: recs,
});

const signals = (s: readonly HealthSignal[]): Map<string, readonly HealthSignal[]> => new Map([["C1", s]]);

describe("guardScaleWithoutFreshCreative (achado do A/B real grok×gemini — fadiga não bloqueava escalar)", () => {
  it("creative_fatigue no alvo → rebaixa increase_budget pra investigate", () => {
    const out = guardScaleWithoutFreshCreative(output([rec({})]), signals(["creative_fatigue"]));
    expect(out.recommendations[0]!.actionType).toBe("investigate");
    expect(out.recommendations[0]!.budgetChangePct).toBeNull();
    expect(out.recommendations[0]!.rationale).toContain("[guard]");
    expect(out.recommendations[0]!.title).toBe("Investigar: t");
  });

  it("weak_hook_retention no alvo → também rebaixa (achado do A/B: NOTE sozinha não bastou)", () => {
    const out = guardScaleWithoutFreshCreative(output([rec({})]), signals(["weak_hook_retention"]));
    expect(out.recommendations[0]!.actionType).toBe("investigate");
    expect(out.recommendations[0]!.rationale).toContain("weak_hook_retention");
  });

  it("weak_creative (score de visão, LLM soft) → NUNCA rebaixa — guard só sobre sinal duro", () => {
    const out = guardScaleWithoutFreshCreative(output([rec({})]), signals(["weak_creative"]));
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("sem sinal de fadiga (ex: só low_volume) → passa direto", () => {
    const out = guardScaleWithoutFreshCreative(output([rec({})]), signals(["low_volume"]));
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("entidade sem sinais mapeados (não era alvo neste run) → passa direto", () => {
    const out = guardScaleWithoutFreshCreative(output([rec({})]), new Map());
    expect(out.recommendations[0]!.actionType).toBe("increase_budget");
  });

  it("ação que não é escala (pause) → nunca tocada, mesmo com fadiga", () => {
    const out = guardScaleWithoutFreshCreative(output([rec({ actionType: "pause" })]), signals(["creative_fatigue"]));
    expect(out.recommendations[0]!.actionType).toBe("pause");
  });

  it("resume (reativar) também é ação de escala → rebaixa igual increase_budget", () => {
    const out = guardScaleWithoutFreshCreative(output([rec({ actionType: "resume" })]), signals(["creative_fatigue"]));
    expect(out.recommendations[0]!.actionType).toBe("investigate");
  });

  it("já rebaixado por outro guard (título já prefixado) → não duplica o prefixo", () => {
    const out = guardScaleWithoutFreshCreative(
      output([rec({ actionType: "investigate", title: "Investigar: t" })]),
      signals(["creative_fatigue"]),
    );
    expect(out.recommendations[0]!.title).toBe("Investigar: t");
  });
});
