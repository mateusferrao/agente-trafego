import { describe, expect, it } from "vitest";
import { describeDeliveryEstimate, isConverterAudienceName, suggestConverterExclusions } from "./index.js";

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

describe("describeDeliveryEstimate", () => {
  it("não pronto → null (caller degrada pro sinal por-público)", () => {
    expect(describeDeliveryEstimate({ ready: false })).toBeNull();
    expect(describeDeliveryEstimate({ ready: false, dailyActiveUsers: 5000 })).toBeNull();
  });
  it("pronto mas sem contagem → null (nada honesto a dizer)", () => {
    expect(describeDeliveryEstimate({ ready: true })).toBeNull();
  });
  it("alcance saudável → nota informativa (sem alarme)", () => {
    const note = describeDeliveryEstimate({ ready: true, dailyActiveUsers: 25000 });
    expect(note).toContain("~25 mil");
    expect(note).not.toContain("⚠️");
  });
  it("alcance abaixo do piso → aviso de entrega fraca", () => {
    const note = describeDeliveryEstimate({ ready: true, dailyActiveUsers: 400 });
    expect(note).toContain("⚠️");
    expect(note).toContain("~400");
    expect(note).toContain("pode entregar pouco");
  });
  it("formata milhões com vírgula PT", () => {
    expect(describeDeliveryEstimate({ ready: true, dailyActiveUsers: 1_200_000 })).toContain("~1,2 mi");
  });
  it("formata milhares fracionários com vírgula PT", () => {
    expect(describeDeliveryEstimate({ ready: true, dailyActiveUsers: 1500 })).toContain("~1,5 mil");
  });
});
