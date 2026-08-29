import { describe, expect, it } from "vitest";
import { isConverterAudienceName, suggestConverterExclusions } from "./index.js";

describe("isConverterAudienceName", () => {
  it("detecta convertidos por nome", () => {
    expect(isConverterAudienceName("Leads - formulário")).toBe(true);
    expect(isConverterAudienceName("Compradores 2026")).toBe(true);
    expect(isConverterAudienceName("Clientes VIP")).toBe(true);
    expect(isConverterAudienceName("Agendaram avaliação")).toBe(true);
  });
  it("não confunde engajamento/visita com convertido", () => {
    expect(isConverterAudienceName("[Instagram][Interagiram] -90 D")).toBe(false);
    expect(isConverterAudienceName("[Instagram][Visitaram] -30 D")).toBe(false);
  });
});

describe("suggestConverterExclusions", () => {
  const auds = [
    { id: "A1", name: "[Instagram][Interagiram] -90 D" },
    { id: "A2", name: "Leads - formulário" },
    { id: "A3", name: "Compradores" },
    { id: "A4", name: "LAL 1% Compradores", isLookalike: true },
  ];
  it("sugere excluir convertidos que não estão incluídos", () => {
    expect(suggestConverterExclusions(auds, ["A1"]).sort()).toEqual(["A2", "A3"]);
  });
  it("não exclui o que está incluído (ainda que pareça convertido)", () => {
    expect(suggestConverterExclusions(auds, ["A1", "A2"]).sort()).toEqual(["A3"]);
  });
  it("nunca exclui lookalike (é frio, não convertido)", () => {
    expect(suggestConverterExclusions(auds, [])).not.toContain("A4");
  });
  it("sem convertidos → vazio", () => {
    expect(suggestConverterExclusions([{ id: "X", name: "Engajamento" }], [])).toEqual([]);
  });
});
