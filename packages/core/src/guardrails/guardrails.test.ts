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

  describe("contexto cross-run + budget-level", () => {
    it("cap de entidades/dia conta o que já foi tocado hoje (cross-run)", () => {
      // 1 entidade já tocada hoje + cap 2 → só cabe mais 1 nova.
      const res = applyGuardrails([action("a"), action("b")], baseCfg, {
        touchedToday: new Set(["ad:x"]),
      });
      expect(res.allowed).toHaveLength(1);
      expect(res.dropped[0]?.reason).toContain("entidades/dia");
    });

    it("não recompõe budget da mesma entidade no dia (anti-compounding)", () => {
      const cut = action("a", { type: "adjust_budget", params: { mode: "decrease", pct: 10 } });
      const res = applyGuardrails([cut], baseCfg, { budgetChangedToday: new Set(["ad:a"]) });
      expect(res.allowed).toHaveLength(0);
      expect(res.dropped[0]?.reason).toContain("budget já ajustado hoje");
    });

    it("dropa adjust_budget quando o nível-alvo não tem budget (pré-check)", () => {
      const bump = action("a", { type: "adjust_budget", params: { mode: "increase", pct: 10 } });
      const res = applyGuardrails([bump], baseCfg, { budgetByEntity: new Map([["ad:a", false]]) });
      expect(res.allowed).toHaveLength(0);
      expect(res.dropped[0]?.reason).toContain("budget não está neste nível");
    });

    it("permite adjust_budget quando o nível tem budget", () => {
      const bump = action("a", { type: "adjust_budget", params: { mode: "increase", pct: 10 } });
      const res = applyGuardrails([bump], baseCfg, { budgetByEntity: new Map([["ad:a", true]]) });
      expect(res.allowed).toHaveLength(1);
    });
  });
});
