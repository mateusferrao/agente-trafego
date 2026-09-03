import { describe, expect, it } from "vitest";
import type { AnalysisOutput, RecommendationActionType } from "@trafego/shared";
import { guardUnconfirmedHypothesis } from "./index.js";
import type { LessonGuard } from "../learning/index.js";

function rec(actionType: RecommendationActionType, externalId?: string) {
  return {
    id: "r1",
    title: "Escalar campanha X",
    rationale: "base",
    actionType,
    severity: "info" as const,
    ...(externalId ? { targetEntity: { level: "campaign" as const, externalId, name: "X" } } : {}),
  };
}
function output(recs: ReturnType<typeof rec>[]): AnalysisOutput {
  return { scorecard: { grade: "B", headline: "h", biggestLeak: "conversao" }, summary: "s", findings: [], recommendations: recs } as unknown as AnalysisOutput;
}
function guard(scope: LessonGuard["key"]["scope"], direction: LessonGuard["key"]["direction"], subjectId?: string): LessonGuard {
  return { id: `g-${subjectId ?? scope}`, key: { scope, dimension: "budget", direction, ...(subjectId ? { subjectId } : {}) } };
}

describe("guardUnconfirmedHypothesis", () => {
  it("rebaixa escala quando há hipótese 'lower' na MESMA entidade", () => {
    const out = guardUnconfirmedHypothesis(output([rec("increase_budget", "c1")]), [guard("entity", "lower", "c1")]);
    expect(out.recommendations[0]?.actionType).toBe("investigate");
    expect(out.recommendations[0]?.rationale).toContain("[guard]");
  });

  it("NÃO mexe numa entidade diferente da hipótese", () => {
    const out = guardUnconfirmedHypothesis(output([rec("increase_budget", "c2")]), [guard("entity", "lower", "c1")]);
    expect(out.recommendations[0]?.actionType).toBe("increase_budget");
  });

  it("hipótese de CONTA (lower) não-confirmada rebaixa TODA escala da conta (v3)", () => {
    const out = guardUnconfirmedHypothesis(output([rec("resume", "cX")]), [guard("account", "lower")]);
    expect(out.recommendations[0]?.actionType).toBe("investigate");
    expect(out.recommendations[0]?.rationale).toContain("cautela ao escalar");
  });

  it("hipótese de CONTA 'raise' NÃO age (só rebaixa, nunca promove)", () => {
    const out = guardUnconfirmedHypothesis(output([rec("increase_budget", "cX")]), [guard("account", "raise")]);
    expect(out.recommendations[0]?.actionType).toBe("increase_budget");
  });

  it("NUNCA promove: uma hipótese 'raise' não torna a ação mais arriscada", () => {
    const passive = output([rec("pause", "c1")]);
    const out = guardUnconfirmedHypothesis(passive, [guard("entity", "raise", "c1")]);
    expect(out.recommendations[0]?.actionType).toBe("pause"); // intocado
  });

  it("não toca ações que não são de escala (pausar/investigar)", () => {
    const out = guardUnconfirmedHypothesis(output([rec("pause", "c1")]), [guard("entity", "lower", "c1")]);
    expect(out.recommendations[0]?.actionType).toBe("pause");
  });

  it("sem guards → passa reto", () => {
    const inp = output([rec("increase_budget", "c1")]);
    expect(guardUnconfirmedHypothesis(inp, [])).toEqual(inp);
  });
});
