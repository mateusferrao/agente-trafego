import { describe, expect, it } from "vitest";
import type { Action } from "@trafego/shared";
import { buildWriteEcho, type EchoItem } from "./index.js";

function item(action: Partial<Action>, over: Partial<EchoItem> = {}): EchoItem {
  return {
    action: {
      id: "a1",
      type: "pause_entity",
      target: { level: "campaign", id: "C1" },
      params: {},
      source: "llm",
      riskLevel: "low",
      reason: "",
      ...action,
    } as Action,
    before: {},
    after: {},
    entityName: "Ruim",
    ...over,
  };
}

describe("buildWriteEcho", () => {
  it("pausa uma campanha → linha + confirma", () => {
    const echo = buildWriteEcho([item({ type: "pause_entity" })]);
    expect(echo).toContain("pausar");
    expect(echo).toContain("*Ruim*");
    expect(echo.toLowerCase()).toContain("confirma?");
  });

  it("reativa uma campanha", () => {
    const echo = buildWriteEcho([item({ type: "resume_entity" }, { entityName: "Boa" })]);
    expect(echo).toContain("reativar");
    expect(echo).toContain("*Boa*");
  });

  it("ajuste de budget mostra R$ antes → depois (minor units → reais)", () => {
    const echo = buildWriteEcho([
      item(
        { type: "adjust_budget", params: { mode: "increase", pct: 100 } },
        { before: { daily_budget: "10000" }, after: { daily_budget: "20000" }, entityName: "Boa" },
      ),
    ]);
    expect(echo).toContain("R$ 100,00");
    expect(echo).toContain("R$ 200,00");
    expect(echo).toContain("*Boa*");
  });

  it("budget clampado (clampedFrom) → diz que passou do limite e o valor final", () => {
    const echo = buildWriteEcho([
      item(
        { type: "adjust_budget", params: { mode: "set", amountMinor: 12000, clampedFrom: 50000 } },
        { before: { daily_budget: "10000" }, after: { daily_budget: "12000" }, entityName: "Boa" },
      ),
    ]);
    expect(echo).toContain("R$ 500,00"); // o pedido original
    expect(echo).toContain("R$ 120,00"); // o valor final (clampado)
    expect(echo.toLowerCase()).toContain("limite");
  });

  it("inclui o nome da conta (@conta) quando fornecido (org multi-conta)", () => {
    const echo = buildWriteEcho([item({ type: "pause_entity" }, { accountName: "Clínica X" })]);
    expect(echo).toContain("Clínica X");
  });

  it("omite a conta quando não fornecida (org de 1 conta)", () => {
    const echo = buildWriteEcho([item({ type: "pause_entity" })]);
    expect(echo).not.toContain("(");
  });

  it("lote de 2 → lista numerada + 'confirma as 2?'", () => {
    const echo = buildWriteEcho([
      item({ type: "pause_entity" }, { entityName: "Ruim" }),
      item(
        { type: "adjust_budget", params: { mode: "decrease", pct: 20 } },
        { before: { daily_budget: "10000" }, after: { daily_budget: "8000" }, entityName: "Boa" },
      ),
    ]);
    expect(echo).toContain("1.");
    expect(echo).toContain("2.");
    expect(echo).toContain("Confirma as 2");
  });

  it("set_status mostra o status alvo", () => {
    const echo = buildWriteEcho([item({ type: "set_status", params: { status: "paused" } })]);
    expect(echo.toLowerCase()).toContain("paus");
  });
});
