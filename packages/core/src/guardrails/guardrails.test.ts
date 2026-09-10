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

  it("exemptEntityCap ISENTA o cap de entidades/dia (ativação em cadeia), mantendo as outras redes", () => {
    const cfg: GuardrailConfig = { ...baseCfg, allowedActions: ["resume_entity"] };
    const acts = [
      action("a", { type: "resume_entity" }),
      action("b", { type: "resume_entity" }),
      action("c", { type: "resume_entity" }),
      action("d", { type: "resume_entity" }),
    ];
    // sem isenção: cap 2 dropa 2
    expect(applyGuardrails(acts, cfg).allowed).toHaveLength(2);
    // com isenção: todas passam
    expect(applyGuardrails(acts, cfg, {}, { exemptEntityCap: true }).allowed).toHaveLength(4);
    // killSwitch/allowedActions seguem valendo mesmo isento
    expect(applyGuardrails(acts, { ...cfg, killSwitch: true }, {}, { exemptEntityCap: true }).allowed).toHaveLength(0);
    expect(applyGuardrails([action("x", { type: "set_status", params: { status: "ACTIVE" } })], cfg, {}, { exemptEntityCap: true }).allowed).toHaveLength(0);
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

  describe("budget set-absoluto (clamp por budget atual)", () => {
    const setAct = (amountMinor: number) =>
      action("a", { type: "adjust_budget", params: { mode: "set", amountMinor } });

    it("dentro do teto de % → passa intacto", () => {
      // atual 10000, alvo 11000 (+10%), teto 20% → ok.
      const res = applyGuardrails([setAct(11000)], baseCfg, { budgetAmountByEntity: new Map([["ad:a", 10000]]) });
      expect(res.allowed).toHaveLength(1);
      expect(res.allowed[0]?.params["amountMinor"]).toBe(11000);
    });

    it("acima do teto (increase) → clampa ao equivalente ao teto", () => {
      // atual 10000, alvo 20000 (+100%), teto 20% → 12000.
      const res = applyGuardrails([setAct(20000)], baseCfg, { budgetAmountByEntity: new Map([["ad:a", 10000]]) });
      expect(res.allowed[0]?.params["amountMinor"]).toBe(12000);
      expect(res.allowed[0]?.params["clampedFrom"]).toBe(20000);
    });

    it("abaixo do teto (decrease) → clampa ao piso do teto", () => {
      // atual 10000, alvo 2000 (-80%), teto 20% → 8000.
      const res = applyGuardrails([setAct(2000)], baseCfg, { budgetAmountByEntity: new Map([["ad:a", 10000]]) });
      expect(res.allowed[0]?.params["amountMinor"]).toBe(8000);
    });

    it("budget atual desconhecido no contexto → dropa (não verifica → não arrisca)", () => {
      const res = applyGuardrails([setAct(20000)], baseCfg, {});
      expect(res.allowed).toHaveLength(0);
      expect(res.dropped[0]?.reason).toContain("budget atual");
    });
  });

  describe("no-op (statusByEntity)", () => {
    const allCfg: GuardrailConfig = {
      ...baseCfg,
      allowedActions: ["pause_entity", "resume_entity", "set_status", "adjust_budget"],
    };

    it("dropa pause_entity quando a entidade já está pausada", () => {
      const res = applyGuardrails([action("a", { type: "pause_entity" })], allCfg, {
        statusByEntity: new Map([["ad:a", "paused"]]),
      });
      expect(res.allowed).toHaveLength(0);
      expect(res.dropped[0]?.reason).toContain("já está");
    });

    it("dropa resume_entity quando a entidade já está ativa", () => {
      const res = applyGuardrails([action("a", { type: "resume_entity" })], allCfg, {
        statusByEntity: new Map([["ad:a", "active"]]),
      });
      expect(res.allowed).toHaveLength(0);
    });

    it("dropa set_status quando já está no status-alvo", () => {
      const res = applyGuardrails(
        [action("a", { type: "set_status", params: { status: "paused" } })],
        allCfg,
        { statusByEntity: new Map([["ad:a", "paused"]]) },
      );
      expect(res.allowed).toHaveLength(0);
    });

    it("permite quando o estado atual diverge do alvo", () => {
      const res = applyGuardrails([action("a", { type: "pause_entity" })], allCfg, {
        statusByEntity: new Map([["ad:a", "active"]]),
      });
      expect(res.allowed).toHaveLength(1);
    });

    it("sem statusByEntity = comportamento legado (não dropa por no-op)", () => {
      const res = applyGuardrails([action("a", { type: "pause_entity" })], allCfg);
      expect(res.allowed).toHaveLength(1);
    });
  });
});
