import { describe, expect, it } from "vitest";
import { HEALTH_VERTICAL_PROFILE, VERTICAL_PROFILES, buildVerticalKnowledgeText, resolveVerticalProfile } from "./index.js";

describe("resolveVerticalProfile (S4 — perfil vertical do agente)", () => {
  it("'health' resolve pro perfil de saúde", () => {
    expect(resolveVerticalProfile("health")).toBe(HEALTH_VERTICAL_PROFILE);
  });
  it("vertical desconhecida/null/undefined → undefined (honesto, nunca inventa perfil)", () => {
    expect(resolveVerticalProfile("automotive")).toBeUndefined();
    expect(resolveVerticalProfile(null)).toBeUndefined();
    expect(resolveVerticalProfile(undefined)).toBeUndefined();
  });
});

describe("VERTICAL_PROFILES registry", () => {
  it("só 'health' registrada por ora (extensível pra odonto/psico/etc depois)", () => {
    expect(Object.keys(VERTICAL_PROFILES)).toEqual(["health"]);
  });
});

describe("buildVerticalKnowledgeText (G6 — kernel sempre anexado, independente de override de identidade)", () => {
  it("perfil ausente → texto vazio (nunca inventa raciocínio de nicho sem perfil)", () => {
    expect(buildVerticalKnowledgeText(undefined)).toBe("");
  });

  it("perfil de saúde: cita funil real (não só CPL), alta consideração/LTV", () => {
    const text = buildVerticalKnowledgeText(HEALTH_VERTICAL_PROFILE);
    expect(text.toUpperCase()).toContain("DIAGNÓSTICO");
    expect(text.toLowerCase()).toContain("alta consideração");
    expect(text.toLowerCase()).toContain("ltv");
  });

  it("cita ritmo reduzido de fim de semana/feriado, com AÇÃO explícita (nunca aplica sozinho)", () => {
    const text = buildVerticalKnowledgeText(HEALTH_VERTICAL_PROFILE);
    expect(text.toLowerCase()).toContain("fim de semana");
    expect(text.toLowerCase()).toContain("aprovação");
  });

  it("cita overlap de audiência CROSS-CAMPANHA (não só irmãos da mesma campanha) com ação concreta", () => {
    const text = buildVerticalKnowledgeText(HEALTH_VERTICAL_PROFILE);
    expect(text.toUpperCase()).toContain("TODAS as campanhas".toUpperCase());
    expect(text.toLowerCase()).toContain("consolidar");
  });

  it("template 'estetico' entra sempre (única template registrada — sem seletor ainda) e NUNCA hardcoda R$", () => {
    const text = buildVerticalKnowledgeText(HEALTH_VERTICAL_PROFILE);
    expect(text.toLowerCase()).toContain("teto");
    expect(text).not.toMatch(/R\$\s*\d/); // nenhum valor em reais hardcoded
  });
});
