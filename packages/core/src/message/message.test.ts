import { describe, expect, it } from "vitest";
import { buildMessageFallback } from "./index.js";

describe("buildMessageFallback", () => {
  it("usa o headline + lista as top-N recomendações", () => {
    const msg = buildMessageFallback(
      {
        accountName: "Loja X",
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

  it("sem headline → cai p/ a primeira frase do resumo", () => {
    const msg = buildMessageFallback({
      accountName: "Loja Y",
      summary: "Tudo estável hoje. Detalhe irrelevante.",
      recommendations: [],
    });
    expect(msg).toContain("Tudo estável hoje.");
    expect(msg).not.toContain("Detalhe irrelevante");
    expect(msg).not.toContain("O que sugiro"); // sem recomendações → sem bloco
  });
});
