import { describe, expect, it } from "vitest";
import { enforceVoice } from "./enforce-voice.js";

describe("enforceVoice — breakInlineBullets", () => {
  it("quebra o caso MyQuick real (sugestões inline viram bullets)", () => {
    const input =
      "A conta MyQuick apresenta CPA médio de R$ 8,62, acima da meta de R$ 7,00, com sinais de fadiga criativa e CTR em queda. - Investigar a anomalia do anúncio 'Lista do Ano' (CTR 10,1% e CPA R$ 1,60) antes de qualquer ação, pois pode ser um erro de rastreamento ou segmentação. - As campanhas TOP 6 e TESTE - Melhores números estão no teto de orçamento, limitando a escala.";
    const out = enforceVoice(input);
    // as duas sugestões viram linhas próprias com bullet
    expect(out).toContain("\n• Investigar");
    expect(out).toContain("\n• As campanhas");
    // NÃO quebra o " - " interno de um NOME de campanha (TESTE - Melhores)
    expect(out).toContain("TESTE - Melhores números");
  });

  it("preserva faixa de valor (R$ 100 - R$ 200) — não é lista", () => {
    const input = "O budget vai de R$ 100 - R$ 200 por dia.";
    expect(enforceVoice(input)).toBe(input);
  });

  it("preserva hífen colado em valor negativo", () => {
    const input = "Você economizou -R$ 50 no período.";
    expect(enforceVoice(input)).toBe(input);
  });
});

describe("enforceVoice — stripAssistantOpeners", () => {
  it("remove abertura de assistente no início", () => {
    expect(enforceVoice("Claro! Vou rodar a análise.")).toBe("Vou rodar a análise.");
    expect(enforceVoice("Com certeza, aqui vai.")).toBe("Aqui vai.");
  });

  it("não remove 'Claro' quando é parte de frase (sem pontuação de interjeição)", () => {
    const input = "Claro que dá pra escalar essa campanha.";
    expect(enforceVoice(input)).toBe(input);
  });
});

describe("enforceVoice — capitalizeFirst (sentence case)", () => {
  it("capitaliza a 1ª letra de mensagem minúscula", () => {
    // "beleza," (abertura calorosa) é PRESERVADA (o kernel quer calor no cumprimento); o
    // travessão dramático em prosa vira vírgula (V1).
    expect(enforceVoice("beleza, rodando — já te aviso.")).toBe("Beleza, rodando, já te aviso.");
    expect(enforceVoice("recebi seu áudio.")).toBe("Recebi seu áudio.");
  });

  it("não toca em início por R$, dígito ou emoji", () => {
    expect(enforceVoice("R$ 50 em campanhas paradas.")).toBe("R$ 50 em campanhas paradas.");
    expect(enforceVoice("3 campanhas ativas.")).toBe("3 campanhas ativas.");
    expect(enforceVoice("💸 R$ 500 parados.")).toBe("💸 R$ 500 parados.");
  });
});

describe("enforceVoice — travessão dramático (V1, rede leve)", () => {
  it("travessão-conector com espaços em prosa → vírgula (some a cara de IA)", () => {
    expect(enforceVoice("A conta vai bem — o CPA caiu esta semana.")).toBe("A conta vai bem, o CPA caiu esta semana.");
  });

  it("PRESERVA a faixa com en-dash (–, U+2013) entre valores — não é travessão", () => {
    expect(enforceVoice("O budget vai de R$ 100 – R$ 200 por dia.")).toBe("O budget vai de R$ 100 – R$ 200 por dia.");
  });

  it("PRESERVA o hífen e o travessão colado (sem espaços) — conservador", () => {
    expect(enforceVoice("Custo-benefício alto.")).toBe("Custo-benefício alto.");
    expect(enforceVoice("bem—assim")).toBe("Bem—assim");
  });

  it("PRESERVA o travessão em LINHA DE LISTA (opções numeradas/bullets)", () => {
    const input = "achei mais de um lugar:\n1. Belo Horizonte — cidade\n2. Belo Vale — cidade\nQual desses?";
    expect(enforceVoice(input)).toBe("Achei mais de um lugar:\n1. Belo Horizonte — cidade\n2. Belo Vale — cidade\nQual desses?");
  });

  it("PRESERVA o travessão dentro de NOME em *negrito* (campanha/conjunto)", () => {
    expect(enforceVoice("Vou criar a campanha *CaquiAI — Conversa* pra você.")).toBe("Vou criar a campanha *CaquiAI — Conversa* pra você.");
  });
});

describe("enforceVoice — idempotência", () => {
  it("aplicar 2× = 1×", () => {
    const input =
      "Claro! A conta apresenta gasto alto — sem meta batida. - Pausar a campanha X. - Reduzir o budget da Y.";
    const once = enforceVoice(input);
    expect(enforceVoice(once)).toBe(once);
  });
});
