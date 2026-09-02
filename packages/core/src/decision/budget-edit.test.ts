import { describe, expect, it } from "vitest";
import { ACTION_PARAM_AMOUNT_MINOR, ACTION_PARAM_MODE, ACTION_PARAM_PCT, BUDGET_MODE_SET } from "@trafego/shared";
import type { Action } from "@trafego/shared";
import { editBudgetActionValue } from "./index.js";

const BASE: Action = {
  id: "a1",
  type: "adjust_budget",
  target: { level: "campaign", id: "c1", name: "Campanha X" },
  params: { [ACTION_PARAM_MODE]: "increase", [ACTION_PARAM_PCT]: 20 },
  source: "llm",
  riskLevel: "medium",
  reason: "escalar vencedor",
};

describe("editBudgetActionValue (C — editar valor da ação antes de aprovar)", () => {
  it("edita o pct (mantém increase/decrease)", () => {
    const r = editBudgetActionValue(BASE, { kind: "pct", mode: "decrease", pct: 30 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action.params[ACTION_PARAM_MODE]).toBe("decrease");
      expect(r.action.params[ACTION_PARAM_PCT]).toBe(30);
    }
  });

  it("edita p/ valor absoluto (mode set + amountMinor)", () => {
    const r = editBudgetActionValue(BASE, { kind: "absolute", amountMinor: 15000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action.params[ACTION_PARAM_MODE]).toBe(BUDGET_MODE_SET);
      expect(r.action.params[ACTION_PARAM_AMOUNT_MINOR]).toBe(15000);
    }
  });

  it("pct <= 0 ou não-finito → erro tipado (não lança)", () => {
    expect(editBudgetActionValue(BASE, { kind: "pct", mode: "increase", pct: 0 }).ok).toBe(false);
    expect(editBudgetActionValue(BASE, { kind: "pct", mode: "increase", pct: Number.NaN }).ok).toBe(false);
  });

  it("valor absoluto não-inteiro/≤0 → erro", () => {
    expect(editBudgetActionValue(BASE, { kind: "absolute", amountMinor: 0 }).ok).toBe(false);
    expect(editBudgetActionValue(BASE, { kind: "absolute", amountMinor: 10.5 }).ok).toBe(false);
  });

  it("ação que não é adjust_budget → erro (pausar não tem valor)", () => {
    const pause: Action = { ...BASE, type: "pause_entity", params: {} };
    expect(editBudgetActionValue(pause, { kind: "pct", mode: "increase", pct: 10 }).ok).toBe(false);
  });
});
