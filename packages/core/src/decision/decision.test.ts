import { describe, expect, it } from "vitest";
import type { Action, AutonomyPolicy } from "@trafego/shared";
import { decideActions } from "./index.js";

function action(id: string, over: Partial<Action> = {}): Action {
  return {
    id,
    type: "pause_entity",
    target: { level: "ad", id },
    params: {},
    source: "playbook",
    riskLevel: "low",
    reason: "test",
    ...over,
  };
}

describe("decideActions", () => {
  it("auto-aplica playbook em act_full, pede OK no llm em suggest", () => {
    const policy: AutonomyPolicy = {
      bySource: { playbook: "act_full", llm: "suggest" },
    };
    const res = decideActions(
      [action("a", { source: "playbook" }), action("b", { source: "llm" })],
      policy,
    );
    expect(res.autoApply.map((a) => a.id)).toEqual(["a"]);
    expect(res.needApproval.map((a) => a.id)).toEqual(["b"]);
  });

  it("act_safe só auto-aplica risco low", () => {
    const policy: AutonomyPolicy = {
      bySource: { playbook: "act_safe", llm: "notify" },
    };
    const res = decideActions(
      [
        action("low", { riskLevel: "low" }),
        action("high", { riskLevel: "high" }),
      ],
      policy,
    );
    expect(res.autoApply.map((a) => a.id)).toEqual(["low"]);
    expect(res.needApproval.map((a) => a.id)).toEqual(["high"]);
  });
});
