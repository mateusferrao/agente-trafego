import { describe, expect, it } from "vitest";
import type { Action, CampaignDraftSpec } from "@trafego/shared";
import { describeActionOutcome, describeCreatedDraft, describeDraftOutcome, readModernizations } from "./index.js";

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

const dupSpec: CampaignDraftSpec = { version: 1, currency: "BRL", dailyBudgetMinor: 8000, activation: "paused" };

describe("describeCreatedDraft", () => {
  it("duplicate → resumo da duplicata com valor formatado", () => {
    expect(describeCreatedDraft("duplicate", dupSpec)).toContain("duplicata do seu vencedor");
  });
});

describe("describeDraftOutcome", () => {
  it("created real → confirma criação pausada", () => {
    expect(describeDraftOutcome({ kind: "created", dryRun: false, summary: "uma campanha nova" })).toContain("Criei");
  });
  it("created dry-run → simulado", () => {
    expect(describeDraftOutcome({ kind: "created", dryRun: true, summary: "x" })).toContain("Simulei a criação");
  });
  it("blocked → motivo", () => {
    expect(describeDraftOutcome({ kind: "blocked", reason: "sem página" })).toBe("Não criei: sem página.");
  });
  it("failed com msg da Meta → próximo passo", () => {
    expect(describeDraftOutcome({ kind: "failed", metaMessage: "A Meta informou: X" })).toContain("Dá pra tentar de novo");
  });
  it("created com modernização → anexa a nota honesta da janela de atribuição", () => {
    const out = describeDraftOutcome({ kind: "created", dryRun: false, summary: "a duplicata do seu vencedor, R$ 80,00/dia", modernizations: [{ code: "attribution_window_modernized" }] });
    expect(out).toContain("Criei");
    expect(out).toContain("janela de atribuição pra 1 dia");
  });
  it("dry-run NÃO anexa modernização (nada foi criado de verdade)", () => {
    const out = describeDraftOutcome({ kind: "created", dryRun: true, summary: "x", modernizations: [{ code: "attribution_window_modernized" }] });
    expect(out).not.toContain("janela de atribuição");
  });
});

describe("readModernizations", () => {
  it("lê só códigos conhecidos de um created_ids cru", () => {
    expect(readModernizations({ modernizations: [{ code: "attribution_window_modernized" }, { code: "desconhecido" }, null, "x"] })).toEqual([{ code: "attribution_window_modernized" }]);
  });
  it("ausente/errado → vazio", () => {
    expect(readModernizations({})).toEqual([]);
    expect(readModernizations({ modernizations: "nope" })).toEqual([]);
  });
});
