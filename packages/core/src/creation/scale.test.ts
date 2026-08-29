import { describe, expect, it } from "vitest";
import type { CampaignDraft } from "@trafego/shared";
import { buildDuplicateInput, planScaleMove } from "./scale.js";

describe("planScaleMove", () => {
  it("CBO (budget na campanha) → sobe o budget da campanha, clampado à faixa segura (eco = valor real)", () => {
    const move = planScaleMove({ scalePct: 50, maxBudgetChangePct: 20, budgetLevel: "campaign" });
    expect(move).toEqual({ move: "raise_budget", pct: 20, level: "campaign" });
  });

  it("CBO + passo dentro da faixa → sobe pelo passo pedido (sem clamp)", () => {
    const move = planScaleMove({ scalePct: 15, maxBudgetChangePct: 20, budgetLevel: "campaign" });
    expect(move).toEqual({ move: "raise_budget", pct: 15, level: "campaign" });
  });

  it("ABO + passo dentro da faixa segura → sobe o budget do adset", () => {
    const move = planScaleMove({ scalePct: 15, maxBudgetChangePct: 20, budgetLevel: "adset" });
    expect(move).toEqual({ move: "raise_budget", pct: 15, level: "adset" });
  });

  it("ABO + passo == teto → ainda sobe budget (limite inclusivo)", () => {
    const move = planScaleMove({ scalePct: 20, maxBudgetChangePct: 20, budgetLevel: "adset" });
    expect(move).toEqual({ move: "raise_budget", pct: 20, level: "adset" });
  });

  it("ABO + passo agressivo (> teto) + sem preferência (default ask) → PERGUNTA (raise seguro vs duplicar)", () => {
    const move = planScaleMove({ scalePct: 50, maxBudgetChangePct: 20, budgetLevel: "adset" });
    expect(move).toEqual({ move: "ask", raisePct: 20, duplicatePct: 50 });
  });

  it("ABO agressivo + choice=duplicate (resposta do usuário) → duplica", () => {
    const move = planScaleMove({ scalePct: 50, maxBudgetChangePct: 20, budgetLevel: "adset", choice: "duplicate" });
    expect(move).toEqual({ move: "duplicate", scalePct: 50 });
  });

  it("ABO agressivo + choice=raise → sobe o budget clampado à faixa segura (não estoura o learning)", () => {
    const move = planScaleMove({ scalePct: 50, maxBudgetChangePct: 20, budgetLevel: "adset", choice: "raise" });
    expect(move).toEqual({ move: "raise_budget", pct: 20, level: "adset" });
  });

  it("ABO agressivo + preferência lembrada = duplicate → duplica sem perguntar", () => {
    const move = planScaleMove({ scalePct: 50, maxBudgetChangePct: 20, budgetLevel: "adset", preference: "duplicate" });
    expect(move).toEqual({ move: "duplicate", scalePct: 50 });
  });

  it("ABO agressivo + preferência lembrada = raise → sobe clampado sem perguntar", () => {
    const move = planScaleMove({ scalePct: 50, maxBudgetChangePct: 20, budgetLevel: "adset", preference: "raise" });
    expect(move).toEqual({ move: "raise_budget", pct: 20, level: "adset" });
  });

  it("choice vence a preferência (usuário respondeu explicitamente)", () => {
    const move = planScaleMove({
      scalePct: 50,
      maxBudgetChangePct: 20,
      budgetLevel: "adset",
      preference: "duplicate",
      choice: "raise",
    });
    expect(move).toEqual({ move: "raise_budget", pct: 20, level: "adset" });
  });
});

describe("buildDuplicateInput", () => {
  const draft: CampaignDraft = {
    kind: "duplicate",
    sourceRef: { level: "adset", id: "AS1" },
    spec: { version: 1, currency: "BRL", dailyBudgetMinor: 9000, activation: "active" },
  };

  it("mapeia sourceRef + budget novo + ativação p/ a entrada de duplicação", () => {
    expect(buildDuplicateInput(draft)).toEqual({
      sourceLevel: "adset",
      sourceId: "AS1",
      status: "active",
      renameSuffix: "escala",
    });
  });

  it("usa o rótulo de sufixo EDITADO quando o spec tem (Slice 7/9)", () => {
    const edited: CampaignDraft = { ...draft, spec: { ...draft.spec, suffixLabel: "escala 2" } };
    expect(buildDuplicateInput(edited).renameSuffix).toBe("escala 2");
  });

  it("lança se o rascunho não é de duplicação", () => {
    const fromScratch: CampaignDraft = { kind: "from_scratch", spec: draft.spec };
    expect(() => buildDuplicateInput(fromScratch)).toThrow();
  });
});
