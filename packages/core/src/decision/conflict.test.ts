import { describe, expect, it } from "vitest";
import type { Action } from "@trafego/shared";
import { resolveActionConflicts } from "./index.js";

function action(id: string, over: Partial<Action> = {}): Action {
  return {
    id,
    type: "pause_entity",
    target: { level: "campaign", id: "c1" },
    params: {},
    source: "llm",
    riskLevel: "low",
    reason: "test",
    ...over,
  };
}

describe("resolveActionConflicts", () => {
  it("pausar domina aumento de budget na mesma entidade", () => {
    const pause = action("p", { type: "pause_entity", source: "playbook" });
    const bump = action("b", { type: "adjust_budget", params: { mode: "increase", pct: 30 } });
    const res = resolveActionConflicts([bump, pause]);
    expect(res.kept.map((a) => a.id)).toEqual(["p"]);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]?.reason).toContain("conflito");
  });

  it("cortar budget vence aumentar na mesma entidade", () => {
    const cut = action("cut", { type: "adjust_budget", params: { mode: "decrease", pct: 20 } });
    const bump = action("up", { type: "adjust_budget", params: { mode: "increase", pct: 20 } });
    const res = resolveActionConflicts([bump, cut]);
    expect(res.kept.map((a) => a.id)).toEqual(["cut"]);
  });

  it("dedupe do mesmo tipo+alvo: playbook vence llm", () => {
    const fromLlm = action("llm", { type: "pause_entity", source: "llm" });
    const fromPlaybook = action("pb", { type: "pause_entity", source: "playbook" });
    const res = resolveActionConflicts([fromLlm, fromPlaybook]);
    expect(res.kept.map((a) => a.id)).toEqual(["pb"]);
    expect(res.dropped).toHaveLength(1);
  });

  it("entidades distintas não conflitam", () => {
    const a = action("a", { target: { level: "campaign", id: "c1" } });
    const b = action("b", { target: { level: "campaign", id: "c2" } });
    const res = resolveActionConflicts([a, b]);
    expect(res.kept).toHaveLength(2);
    expect(res.dropped).toHaveLength(0);
  });

  it("preserva a ordem original das mantidas", () => {
    const a = action("a", { target: { level: "campaign", id: "c1" } });
    const b = action("b", { target: { level: "campaign", id: "c2" } });
    const c = action("c", { target: { level: "campaign", id: "c3" } });
    const res = resolveActionConflicts([a, b, c]);
    expect(res.kept.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
