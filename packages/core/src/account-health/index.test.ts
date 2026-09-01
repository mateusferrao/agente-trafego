import { describe, expect, it } from "vitest";
import type { AccountHealth } from "@trafego/shared/types";
import type { AccountHealthAlertPolicy } from "@trafego/shared/schemas";
import { detectAccountHealthTriggers, describeAccountHealthAlert, type PreviousAccountHealthSnapshot } from "./index.js";

const policy = (over: Partial<AccountHealthAlertPolicy> = {}): AccountHealthAlertPolicy => ({
  enabled: true,
  statusTriggers: ["disabled", "unsettled", "grace_period", "pending_review", "pending_settlement", "pending_closure", "closed", "unknown"],
  spendThreshold: { source: "meta_cap" },
  balanceThreshold: { enabled: false },
  ...over,
});

const prev = (over: Partial<PreviousAccountHealthSnapshot> = {}): PreviousAccountHealthSnapshot => ({
  status: "active",
  amountSpentMajor: null,
  balanceMajor: null,
  ...over,
});

const health = (over: Partial<AccountHealth> = {}): AccountHealth => ({
  status: "active",
  checkedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("detectAccountHealthTriggers", () => {
  it("policy desligada → nenhum gatilho, mesmo com transição real", () => {
    const events = detectAccountHealthTriggers(prev(), health({ status: "disabled" }), policy({ enabled: false }));
    expect(events).toEqual([]);
  });

  it("status transiciona active→disabled, e disabled está no checklist → dispara", () => {
    const events = detectAccountHealthTriggers(prev(), health({ status: "disabled" }), policy());
    expect(events).toEqual([{ kind: "status", status: "disabled" }]);
  });

  it("status transiciona active→disabled, mas dono DESMARCOU disabled do checklist → não dispara", () => {
    const events = detectAccountHealthTriggers(prev(), health({ status: "disabled" }), policy({ statusTriggers: ["closed"] }));
    expect(events).toEqual([]);
  });

  it("status continua disabled→disabled (sem mudança) → NÃO redispara", () => {
    const events = detectAccountHealthTriggers(prev({ status: "disabled" }), health({ status: "disabled" }), policy());
    expect(events).toEqual([]);
  });

  it("1º sync de uma conta já desativada (previous null) → dispara (honesto, não fica silencioso pra sempre)", () => {
    const events = detectAccountHealthTriggers(prev({ status: null }), health({ status: "disabled" }), policy());
    expect(events).toEqual([{ kind: "status", status: "disabled" }]);
  });

  it("status volta pra active → nunca dispara (não é um problema)", () => {
    const events = detectAccountHealthTriggers(prev({ status: "disabled" }), health({ status: "active" }), policy());
    expect(events).toEqual([]);
  });

  it("teto de gasto (fonte Meta): cruza o spendCapMajor pela 1ª vez → dispara", () => {
    const events = detectAccountHealthTriggers(
      prev({ amountSpentMajor: 900 }),
      health({ amountSpentMajor: 1000, spendCapMajor: 1000 }),
      policy(),
    );
    expect(events).toEqual([{ kind: "spend_cap", spendCapMajor: 1000 }]);
  });

  it("teto de gasto: já estava acima antes → NÃO redispara", () => {
    const events = detectAccountHealthTriggers(
      prev({ amountSpentMajor: 1000 }),
      health({ amountSpentMajor: 1050, spendCapMajor: 1000 }),
      policy(),
    );
    expect(events).toEqual([]);
  });

  it("teto de gasto (fonte custom): usa o valor do dono, ignora spendCapMajor da Meta", () => {
    const events = detectAccountHealthTriggers(
      prev({ amountSpentMajor: 400 }),
      health({ amountSpentMajor: 500, spendCapMajor: 10000 }), // Meta ainda longe do teto
      policy({ spendThreshold: { source: "custom", customValueMajor: 500 } }),
    );
    expect(events).toEqual([{ kind: "spend_cap", spendCapMajor: 500 }]);
  });

  it("spend_cap ausente (Meta sem teto, achado \"0\") e sem custom → nunca dispara", () => {
    const events = detectAccountHealthTriggers(
      prev({ amountSpentMajor: 999999 }),
      health({ amountSpentMajor: 1000000 }), // sem spendCapMajor
      policy(),
    );
    expect(events).toEqual([]);
  });

  it("saldo baixo: fundingType stored_balance + threshold ligado + cruza → dispara", () => {
    const events = detectAccountHealthTriggers(
      prev({ balanceMajor: 100 }),
      health({ balanceMajor: 40, fundingType: "stored_balance" }),
      policy({ balanceThreshold: { enabled: true, customValueMajor: 50 } }),
    );
    expect(events).toEqual([{ kind: "balance", balanceMajor: 40 }]);
  });

  it("saldo baixo: fundingType \"other\" (cartão/fatura) → NUNCA dispara, mesmo com threshold ligado e cruzado", () => {
    const events = detectAccountHealthTriggers(
      prev({ balanceMajor: 100 }),
      health({ balanceMajor: 40, fundingType: "other" }),
      policy({ balanceThreshold: { enabled: true, customValueMajor: 50 } }),
    );
    expect(events).toEqual([]);
  });

  it("saldo baixo: threshold desligado → não dispara mesmo em stored_balance cruzando", () => {
    const events = detectAccountHealthTriggers(
      prev({ balanceMajor: 100 }),
      health({ balanceMajor: 10, fundingType: "stored_balance" }),
      policy({ balanceThreshold: { enabled: false, customValueMajor: 50 } }),
    );
    expect(events).toEqual([]);
  });

  it("todos os gatilhos podem disparar juntos no mesmo sync", () => {
    const events = detectAccountHealthTriggers(
      prev({ status: "active", amountSpentMajor: 900, balanceMajor: 100 }),
      health({ status: "disabled", amountSpentMajor: 1000, spendCapMajor: 1000, balanceMajor: 10, fundingType: "stored_balance" }),
      policy({ balanceThreshold: { enabled: true, customValueMajor: 50 } }),
    );
    expect(events.map((e) => e.kind).sort()).toEqual(["balance", "spend_cap", "status"]);
  });
});

describe("describeAccountHealthAlert", () => {
  it("status: menciona o nome da conta e a copy do status (sem travessão)", () => {
    const text = describeAccountHealthAlert({ kind: "status", status: "disabled" }, "My QuickStart Campaign", "BRL");
    expect(text).toContain("My QuickStart Campaign");
    expect(text).toContain("Conta desativada, parou de veicular anúncios");
    expect(text).not.toContain("—");
  });

  it("spend_cap: menciona o valor formatado na moeda certa", () => {
    const text = describeAccountHealthAlert({ kind: "spend_cap", spendCapMajor: 5000 }, "Conta X", "BRL");
    expect(text).toContain("R$ 5000,00");
    expect(text).not.toContain("—");
  });

  it("balance: menciona o saldo atual formatado", () => {
    const text = describeAccountHealthAlert({ kind: "balance", balanceMajor: 42.5 }, "Conta X", "BRL");
    expect(text).toContain("R$ 42,50");
    expect(text).not.toContain("—");
  });

  it("token_invalid: mensagem fixa, sem depender de dados do evento", () => {
    const text = describeAccountHealthAlert({ kind: "token_invalid" }, "Conta X", "BRL");
    expect(text).toContain("reconecte");
    expect(text).not.toContain("—");
  });
});
