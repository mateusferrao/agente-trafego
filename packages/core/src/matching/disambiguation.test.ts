import { describe, expect, it } from "vitest";
import { resolveDisambiguationChoice, type DisambiguationOption } from "./disambiguation.js";

// Opções congeladas no gate (o `id` é o id externo/opaco — interesse/campanha/página).
const opts: DisambiguationOption[] = [
  { index: 1, id: "iid_111", name: "Futebol americano" },
  { index: 2, id: "iid_222", name: "Futebol" },
  { index: 3, id: "iid_333", name: "NFL" },
];

describe("resolveDisambiguationChoice — por índice", () => {
  it("dígito puro '1' → 1ª opção (o bug reportado)", () => {
    const c = resolveDisambiguationChoice(opts, "1");
    expect(c).toEqual({ kind: "resolved", option: opts[0] });
  });

  it("'opção 2' / 'opcao 2' / 'o 3' / 'n 2' / '#2' / '2)' / '2.' → índice", () => {
    expect(resolveDisambiguationChoice(opts, "opção 2")).toEqual({ kind: "resolved", option: opts[1] });
    expect(resolveDisambiguationChoice(opts, "opcao 2")).toEqual({ kind: "resolved", option: opts[1] });
    expect(resolveDisambiguationChoice(opts, "o 3")).toEqual({ kind: "resolved", option: opts[2] });
    expect(resolveDisambiguationChoice(opts, "n 2")).toEqual({ kind: "resolved", option: opts[1] });
    expect(resolveDisambiguationChoice(opts, "#2")).toEqual({ kind: "resolved", option: opts[1] });
    expect(resolveDisambiguationChoice(opts, "2)")).toEqual({ kind: "resolved", option: opts[1] });
    expect(resolveDisambiguationChoice(opts, "2.")).toEqual({ kind: "resolved", option: opts[1] });
  });

  it("ordinal por extenso 'primeiro'/'a segunda'/'terceiro' → índice", () => {
    expect(resolveDisambiguationChoice(opts, "primeiro")).toEqual({ kind: "resolved", option: opts[0] });
    expect(resolveDisambiguationChoice(opts, "a segunda")).toEqual({ kind: "resolved", option: opts[1] });
    expect(resolveDisambiguationChoice(opts, "terceiro")).toEqual({ kind: "resolved", option: opts[2] });
  });

  it("índice fora de faixa → NÃO resolve por índice (cai no nome; sem match → unresolved)", () => {
    expect(resolveDisambiguationChoice(opts, "9").kind).toBe("unresolved");
    expect(resolveDisambiguationChoice(opts, "0").kind).toBe("unresolved");
  });
});

describe("resolveDisambiguationChoice — por nome (reusa resolveNamedMatch)", () => {
  it("nome exato (acento/caixa tolerados) → resolve", () => {
    expect(resolveDisambiguationChoice(opts, "futebol americano")).toEqual({ kind: "resolved", option: opts[0] });
    expect(resolveDisambiguationChoice(opts, "NFL")).toEqual({ kind: "resolved", option: opts[2] });
  });

  it("nome distinto com folga → resolve", () => {
    expect(resolveDisambiguationChoice(opts, "americano")).toEqual({ kind: "resolved", option: opts[0] });
  });

  it("frase-pedido que não é escolha → unresolved (deixa pro LLM)", () => {
    expect(resolveDisambiguationChoice(opts, "muda o orçamento pra 100").kind).toBe("unresolved");
    expect(resolveDisambiguationChoice(opts, "na verdade quero pausar a campanha").kind).toBe("unresolved");
  });

  it("nome ambíguo (bate em 2 opções sem folga) → unresolved (pergunta de novo)", () => {
    const ambOpts: DisambiguationOption[] = [
      { index: 1, id: "a", name: "Remarketing Loja Norte" },
      { index: 2, id: "b", name: "Remarketing Loja Sul" },
    ];
    expect(resolveDisambiguationChoice(ambOpts, "remarketing loja").kind).toBe("unresolved");
  });

  it("lista vazia → unresolved", () => {
    expect(resolveDisambiguationChoice([], "1").kind).toBe("unresolved");
  });
});
