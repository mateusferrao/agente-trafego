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

  it("byAction VENCE bySource: ação com override sobe/desce independente da origem", () => {
    // origem llm = act_full (auto), mas adjust_budget tem override suggest → pede OK;
    // pause_entity sem override herda a origem (act_full → auto).
    const policy: AutonomyPolicy = {
      bySource: { playbook: "suggest", llm: "act_full" },
      byAction: { adjust_budget: "suggest" },
    };
    const res = decideActions(
      [
        action("pause", { source: "llm", type: "pause_entity" }),
        action("budget", { source: "llm", type: "adjust_budget", riskLevel: "low" }),
      ],
      policy,
    );
    expect(res.autoApply.map((a) => a.id)).toEqual(["pause"]);
    expect(res.needApproval.map((a) => a.id)).toEqual(["budget"]);
  });

  it("byAction pode LIBERAR uma ação numa origem conservadora", () => {
    const policy: AutonomyPolicy = {
      bySource: { playbook: "suggest", llm: "suggest" },
      byAction: { pause_entity: "act_full" },
    };
    const res = decideActions([action("p", { source: "llm", type: "pause_entity" })], policy);
    expect(res.autoApply.map((a) => a.id)).toEqual(["p"]);
  });

  it("ação com RESSALVA nunca auto-aplica, mesmo em act_full (Fatia A)", () => {
    const policy: AutonomyPolicy = { bySource: { playbook: "act_full", llm: "act_full" } };
    const res = decideActions(
      [
        action("limpa", { source: "llm", type: "adjust_budget", riskLevel: "medium" }),
        action("comRessalva", {
          source: "llm",
          type: "adjust_budget",
          riskLevel: "medium",
          ressalvas: [{ code: "creative_fatigue", message: "fadiga" }],
        }),
      ],
      policy,
    );
    expect(res.autoApply.map((a) => a.id)).toEqual(["limpa"]);
    expect(res.needApproval.map((a) => a.id)).toEqual(["comRessalva"]);
  });
});
