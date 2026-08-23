import { describe, expect, it } from "vitest";
import { WHATSAPP_SOFT_MAX_CHARS, WHATSAPP_SPLIT_MAX_PARTS, splitMessage } from "./split.js";

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

  it("respeita o cap: excedente é juntado no último bloco", () => {
    const many = Array.from({ length: WHATSAPP_SPLIT_MAX_PARTS + 3 }, (_, i) => `b${i}`).join("\n\n");
    const parts = splitMessage(many);
    expect(parts).toHaveLength(WHATSAPP_SPLIT_MAX_PARTS);
    expect(parts.at(-1)).toContain("\n\n"); // o último carrega o excedente juntado
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
