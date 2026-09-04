import { describe, expect, it } from "vitest";
import type { Action } from "@trafego/shared";
import { describeActionOutcome } from "./index.js";

const budget: Action = { id: "a", type: "adjust_budget", target: { level: "adset", id: "1", name: "Leads — 8510" }, params: {}, source: "llm", riskLevel: "medium", reason: "x" };
const pause: Action = { ...budget, type: "pause_entity" };
const audience: Action = { ...budget, type: "adjust_audience" };
const noName: Action = { ...budget, target: { level: "adset", id: "1" } };

describe("describeActionOutcome", () => {
  it("applied real → 1ª pessoa + o quê (por tipo)", () => {
    expect(describeActionOutcome(budget, { kind: "applied" })).toBe("Ajustei o orçamento de Leads — 8510.");
    expect(describeActionOutcome(pause, { kind: "applied" })).toBe("Pausei Leads — 8510.");
    expect(describeActionOutcome(audience, { kind: "applied" })).toBe("Ajustei o público de Leads — 8510.");
  });
  it("simulated (ensaio) → honesto, sem mexer", () => {
    const out = describeActionOutcome(budget, { kind: "simulated" });
    expect(out).toContain("Simulei");
    expect(out).toContain("sem mexer na conta");
  });
  it("blocked → o que + motivo", () => {
    expect(describeActionOutcome(budget, { kind: "blocked", reason: "budget já ajustado hoje" })).toBe("Não apliquei (Leads — 8510): budget já ajustado hoje.");
  });
  it("noop → já estava assim", () => {
    expect(describeActionOutcome(budget, { kind: "noop" })).toContain("Não precisei mexer");
  });
  it("failed → mensagem da Meta quando houver, senão próximo passo", () => {
    expect(describeActionOutcome(budget, { kind: "failed", metaMessage: "A Meta informou: limite" })).toBe("A Meta informou: limite. Dá pra tentar de novo.");
    expect(describeActionOutcome(budget, { kind: "failed", metaMessage: "A Meta informou: sem saldo." })).toBe("A Meta informou: sem saldo. Dá pra tentar de novo.");
    expect(describeActionOutcome(budget, { kind: "failed" })).toContain("Tenta de novo");
  });
  it("sem nome no alvo → não quebra (sem sufixo)", () => {
    expect(describeActionOutcome(noName, { kind: "blocked", reason: "x" })).toBe("Não apliquei: x.");
  });
});
