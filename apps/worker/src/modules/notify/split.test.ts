import { describe, expect, it } from "vitest";
import { WHATSAPP_SPLIT_MAX_PARTS, splitMessage } from "./split.js";

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
});
