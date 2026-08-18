import { describe, expect, it } from "vitest";
import type { Action, GuardrailConfig } from "@trafego/shared";
import { applyGuardrails } from "./index.js";

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

const baseCfg: GuardrailConfig = {
  maxBudgetChangePct: 20,
  maxEntitiesPerDay: 2,
  allowedActions: ["pause_entity", "adjust_budget"],
  dryRun: false,
  killSwitch: false,
};

describe("applyGuardrails", () => {
  it("kill switch descarta tudo", () => {
    const res = applyGuardrails([action("a"), action("b")], { ...baseCfg, killSwitch: true });
    expect(res.allowed).toHaveLength(0);
    expect(res.dropped).toHaveLength(2);
  });

  it("descarta ações de tipo não permitido", () => {
    const res = applyGuardrails([action("a", { type: "set_status" })], baseCfg);
    expect(res.allowed).toHaveLength(0);
    expect(res.dropped[0]?.reason).toContain("não permitida");
  });

  it("faz clamp do % de budget acima do teto", () => {
    const big = action("a", { type: "adjust_budget", params: { mode: "increase", pct: 80 } });
    const res = applyGuardrails([big], baseCfg);
    expect(res.allowed).toHaveLength(1);
    expect(res.allowed[0]?.params["pct"]).toBe(20);
    expect(res.allowed[0]?.params["clampedFrom"]).toBe(80);
  });

  it("limita entidades/dia", () => {
    const res = applyGuardrails([action("a"), action("b"), action("c")], baseCfg);
    expect(res.allowed).toHaveLength(2);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]?.reason).toContain("entidades/dia");
  });
});
