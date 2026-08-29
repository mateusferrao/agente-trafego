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
    expect(describeDeliveryEstimate({ ready: false, monthlyReachMin: 50000, monthlyReachMax: 60000 })).toBeNull();
  });
  it("pronto mas sem contagem → null (nada honesto a dizer)", () => {
    expect(describeDeliveryEstimate({ ready: true })).toBeNull();
  });
  it("achatado no piso de privacidade da Meta (≤1000) → null (não informativo → fallback por-público)", () => {
    // caso REAL do E2E: custom audience pequena/privada volta 1000–1000 (piso), não o tamanho real.
    expect(describeDeliveryEstimate({ ready: true, monthlyReachMin: 1000, monthlyReachMax: 1000 })).toBeNull();
  });
  it("faixa mensal saudável → nota informativa com faixa (sem alarme)", () => {
    // caso REAL do E2E: BR amplo ~163,5 mi–192,3 mi/mês.
    const note = describeDeliveryEstimate({ ready: true, monthlyReachMin: 163_500_000, monthlyReachMax: 192_300_000 });
    expect(note).toContain("~163,5 mi–192,3 mi");
    expect(note).toContain("pessoas/mês");
    expect(note).not.toContain("⚠️");
  });
  it("faixa mensal acima do piso mas magra → aviso de entrega fraca", () => {
    const note = describeDeliveryEstimate({ ready: true, monthlyReachMin: 2000, monthlyReachMax: 4000 });
    expect(note).toContain("⚠️");
    expect(note).toContain("~2 mil–4 mil");
    expect(note).toContain("pode entregar pouco");
  });
  it("min==max → mostra valor único (sem faixa)", () => {
    expect(describeDeliveryEstimate({ ready: true, monthlyReachMin: 50000, monthlyReachMax: 50000 })).toContain("~50 mil pessoas/mês");
  });
  it("sem faixa mensal, só DAU (fallback raro) → usa o diário", () => {
    const note = describeDeliveryEstimate({ ready: true, dailyActiveUsers: 25000 });
    expect(note).toContain("~25 mil");
    expect(note).toContain("pessoas ativas/dia");
    expect(note).not.toContain("⚠️");
  });
  it("DAU no piso → null (degrada)", () => {
    expect(describeDeliveryEstimate({ ready: true, dailyActiveUsers: 800 })).toBeNull();
  });
});
