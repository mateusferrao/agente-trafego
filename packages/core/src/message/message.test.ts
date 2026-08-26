import { describe, expect, it } from "vitest";
import { buildMessageFallback } from "./index.js";

describe("buildMessageFallback", () => {
  it("usa o headline + lista as top-N recomendações", () => {
    const msg = buildMessageFallback(
      {
        accountName: "Loja X",
        currency: "BRL",
        headline: "CPA acima da meta na campanha principal.",
        summary: "Resumo longo. Segunda frase.",
        recommendations: [{ title: "Pausar Campanha A" }, { title: "Revisar criativo B" }, { title: "Subir budget C" }, { title: "Quarta" }],
      },
      3,
    );
    expect(msg).toContain("📊 Loja X");
    expect(msg).toContain("CPA acima da meta na campanha principal.");
    expect(msg).toContain("• Pausar Campanha A");
    expect(msg).toContain("• Subir budget C");
    expect(msg).not.toContain("• Quarta"); // cap = 3
  });

  it("money shot: abre pelo desperdício em reais quando material", () => {
    const msg = buildMessageFallback({
      accountName: "Clínica Z",
      currency: "BRL",
      headline: "Entrega ok.",
      summary: "s",
      recommendations: [{ title: "Pausar zumbi" }],
      money: { wastedSpend: 1600, wastedPct: 16 },
    });
    const lines = msg.split("\n");
    expect(lines[0]).toContain("Clínica Z");
    expect(lines[1]).toContain("R$ 1600,00");
    expect(lines[1]).toContain("16%");
  });

  it("desperdício zero → não abre com money shot", () => {
    const msg = buildMessageFallback({
      accountName: "Loja W",
      currency: "BRL",
      headline: "Tudo certo.",
      summary: "s",
      recommendations: [],
      money: { wastedSpend: 0, wastedPct: 0 },
    });
    expect(msg).not.toContain("R$");
  });

  it("sem headline → cai p/ a primeira frase do resumo", () => {
    const msg = buildMessageFallback({
      accountName: "Loja Y",
      currency: "BRL",
      summary: "Tudo estável hoje. Detalhe irrelevante.",
      recommendations: [],
    });
    expect(msg).toContain("Tudo estável hoje.");
    expect(msg).not.toContain("Detalhe irrelevante");
    expect(msg).not.toContain("O que sugiro"); // sem recomendações → sem bloco
  });
});
