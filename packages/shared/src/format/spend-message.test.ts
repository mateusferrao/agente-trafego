import { describe, expect, it } from "vitest";
import { formatSpendMessage } from "./spend-message.js";

describe("formatSpendMessage", () => {
  it("monta a frase com conta, moeda, gasto (2 casas) e janela", () => {
    const msg = formatSpendMessage({
      accountName: "Minha Conta",
      currency: "BRL",
      spend: 42.5,
      windowLabel: "nos últimos 7 dias",
    });
    expect(msg).toBe("Conta Minha Conta: gastou BRL 42.50 nos últimos 7 dias.");
  });

  it("sempre 2 casas decimais (inclui zero)", () => {
    expect(
      formatSpendMessage({ accountName: "X", currency: "USD", spend: 0, windowLabel: "hoje" }),
    ).toBe("Conta X: gastou USD 0.00 hoje.");
  });
});
