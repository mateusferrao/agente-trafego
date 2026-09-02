import { describe, expect, it } from "vitest";
import { WHATSAPP_SOFT_MAX_CHARS, WHATSAPP_SPLIT_MAX_PARTS, joinBalloons, splitMessage } from "./split.js";

/** Frase determinística de ~n chars terminada em ponto (fronteira de frase). */
function sentence(n: number): string {
  return `${"x".repeat(Math.max(1, n - 1))}.`;
}

describe("splitMessage", () => {
  it("quebra em blocos separados por 2+ quebras de linha", () => {
    expect(splitMessage("primeiro bloco\n\nsegundo bloco")).toEqual(["primeiro bloco", "segundo bloco"]);
  });

  it("trata 3+ quebras como um único separador", () => {
    expect(splitMessage("a\n\n\n\nb")).toEqual(["a", "b"]);
  });

  it("mantém quebras simples (uma ideia com várias linhas) juntas", () => {
    expect(splitMessage("linha 1\nlinha 2\n\noutro bloco")).toEqual(["linha 1\nlinha 2", "outro bloco"]);
  });

  it("texto sem quebra dupla → uma única mensagem", () => {
    expect(splitMessage("só uma mensagem")).toEqual(["só uma mensagem"]);
  });

  it("descarta blocos vazios", () => {
    expect(splitMessage("a\n\n   \n\nb")).toEqual(["a", "b"]);
  });

  it("acima do cap, empacota parágrafos curtos vizinhos em vez de 1 balão cada (achado real)", () => {
    // 8 blocos de 2 chars: juntos cabem tranquilo num único balão (bem abaixo do alvo de
    // 600) — antes do fix, viravam 5 balões (4 soltos + o resto cru dumped no 5º).
    const many = Array.from({ length: WHATSAPP_SPLIT_MAX_PARTS + 3 }, (_, i) => `b${i}`).join("\n\n");
    const parts = splitMessage(many);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(many);
  });

  it("cap ainda vale quando nem empacotado cabe em 5 balões — junta o excedente no último", () => {
    // parágrafos de ~250 chars: só 2 cabem por balão (~500), 12 deles não cabem em 5.
    const para = (n: number) => `${"x".repeat(n - 1)}.`;
    const many = Array.from({ length: 12 }, () => para(250)).join("\n\n");
    const parts = splitMessage(many);
    expect(parts).toHaveLength(WHATSAPP_SPLIT_MAX_PARTS);
    expect(parts.at(-1)).toContain("\n\n"); // o último carrega o excedente juntado
  });

  it("achado real: título + cabeçalhos curtos ficam empacotados com o próximo parágrafo, não isolados", () => {
    const text = [
      "*My QuickStart Campaign — comparação atualizada*",
      "*Veredito:* o acumulado está saudável, mas hoje houve deterioração de eficiência.",
      "*Dados até 01/09*",
      "*7 dias — 26/08 a 01/09*",
      "• Gasto: R$ 4.825,16\n• Conversas: 586\n• CPA: R$ 8,23",
      "*3 dias — 30/08 a 01/09*",
      "• Gasto: R$ 1.580,17\n• Conversas: 193\n• CPA: R$ 8,19",
      "*Hoje — 01/09 até agora*",
      "• Gasto: R$ 124,79\n• Conversas: 5\n• CPA: R$ 24,96",
    ].join("\n\n");
    const parts = splitMessage(text);
    // nenhum título/cabeçalho vira balão sozinho quando cabe junto do próximo — bug
    // original mandava cada linha curta isolada até o 4º e jogava o resto no 5º cru.
    expect(parts.length).toBeLessThan(WHATSAPP_SPLIT_MAX_PARTS);
    for (const p of parts) expect(p.length).toBeGreaterThan(20); // nada isolado como fragmento minúsculo
  });

  it("texto vazio → nenhuma mensagem", () => {
    expect(splitMessage("   ")).toEqual([]);
  });

  it("bloco curto (abaixo do alvo) não é subdividido", () => {
    const short = "uma frase. outra frase. e mais uma.";
    expect(short.length).toBeLessThan(WHATSAPP_SOFT_MAX_CHARS);
    expect(splitMessage(short)).toEqual([short]);
  });

  it("bloco longo de prosa é subdividido por frase (nunca corta frase)", () => {
    const s = sentence(200);
    const block = [s, s, s, s].join(" "); // ~807 chars, sem \n\n
    const parts = splitMessage(block);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(WHATSAPP_SOFT_MAX_CHARS);
      expect(p.endsWith(".")).toBe(true); // fechou no fim de uma frase
    }
    // nada se perde: todas as frases reaparecem
    expect(parts.join(" ").replace(/\s+/g, "")).toBe(block.replace(/\s+/g, ""));
  });

  it("frase única maior que o alvo é mantida inteira (não corta no meio)", () => {
    const giant = sentence(WHATSAPP_SOFT_MAX_CHARS + 100);
    const parts = splitMessage(giant);
    expect(parts).toEqual([giant]);
  });

  it("bloco longo de várias linhas é reagrupado por linha (sem partir linha)", () => {
    const line = `• ${"x".repeat(60)}`; // ~62 chars
    const block = Array.from({ length: 12 }, () => line).join("\n"); // ~744 chars
    const parts = splitMessage(block);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(WHATSAPP_SOFT_MAX_CHARS);
      // cada balão é composto de linhas inteiras
      for (const l of p.split("\n")) expect(l).toBe(line);
    }
  });
});

describe("joinBalloons", () => {
  it("junta parágrafos com fronteira de balão (\\n\\n) → splitMessage separa cada um", () => {
    const echo = joinBalloons(["primeira ideia.", "segunda ideia.", "confirma?"]);
    expect(echo).toBe("primeira ideia.\n\nsegunda ideia.\n\nconfirma?");
    expect(splitMessage(echo)).toHaveLength(3);
  });

  it("descarta parágrafos vazios/em branco (linhas opcionais condicionais)", () => {
    expect(joinBalloons(["a", "", "  ", "b"])).toBe("a\n\nb");
  });

  it("faz trim de cada parágrafo", () => {
    expect(joinBalloons(["  a  ", " b "])).toBe("a\n\nb");
  });

  it("um parágrafo só → sem separador (um balão)", () => {
    const echo = joinBalloons(["só isso"]);
    expect(echo).toBe("só isso");
    expect(splitMessage(echo)).toEqual(["só isso"]);
  });
});
