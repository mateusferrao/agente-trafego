import { describe, expect, it } from "vitest";
import { resolveStructure, resolveAdvantage, structureNotation, type CampaignIntent } from "./index.js";

describe("resolveStructure — playbook do squad (recomendação; o dono decide)", () => {
  it("teste → CBO 1-1-5 (default); anúncios overridável (10)", () => {
    expect(resolveStructure("test")).toMatchObject({ budgetMode: "cbo", adsets: 1, ads: 5 });
    expect(resolveStructure("test", { ads: 10 })).toMatchObject({ budgetMode: "cbo", adsets: 1, ads: 10 });
  });

  it("escalar vencedor → sempre CBO 1-1-5", () => {
    expect(resolveStructure("scale")).toMatchObject({ budgetMode: "cbo", adsets: 1, ads: 5 });
  });

  it("teste isolado (1 criativo/ângulo) → ABO 1-1-1", () => {
    expect(resolveStructure("isolated_test")).toMatchObject({ budgetMode: "abo", adsets: 1, ads: 1 });
  });

  it("teste de público → CBO 1-N-1 (N segmentos, 1 anúncio cada)", () => {
    expect(resolveStructure("audience_test", { segments: 5 })).toMatchObject({ budgetMode: "cbo", adsets: 5, ads: 1 });
    // sem nº de segmentos → default sensato (>=2, senão não é teste de público)
    expect(resolveStructure("audience_test").adsets).toBeGreaterThanOrEqual(2);
  });

  it("criar genérico → default híbrido = teste CBO 1-1-5", () => {
    expect(resolveStructure("create")).toMatchObject({ budgetMode: "cbo", adsets: 1, ads: 5 });
  });

  it("clamps: adsets/ads nunca abaixo de 1", () => {
    expect(resolveStructure("test", { ads: 0 }).ads).toBeGreaterThanOrEqual(1);
    expect(resolveStructure("audience_test", { segments: 0 }).adsets).toBeGreaterThanOrEqual(2);
  });

  it("carrega um rationale (pro eco honesto do porquê)", () => {
    for (const intent of ["test", "scale", "isolated_test", "audience_test", "create"] as CampaignIntent[]) {
      expect(resolveStructure(intent).rationale.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveAdvantage — negócio local (recomendação)", () => {
  it("local → OFF (público fixo); não-local → ON (liga tudo)", () => {
    expect(resolveAdvantage({ localBusiness: true })).toBe(false);
    expect(resolveAdvantage({ localBusiness: false })).toBe(true);
  });
});

describe("structureNotation — C-adset-ad (1 campanha)", () => {
  it("formata a notação do squad", () => {
    expect(structureNotation(resolveStructure("audience_test", { segments: 5 }))).toBe("1-5-1");
    expect(structureNotation(resolveStructure("test"))).toBe("1-1-5");
    expect(structureNotation(resolveStructure("isolated_test"))).toBe("1-1-1");
  });
});
