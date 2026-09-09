import { describe, expect, it } from "vitest";
import type { EntitySummary } from "@trafego/shared";
import {
  resolveStructure,
  resolveAdvantage,
  structureNotation,
  pickGrowthMove,
  nextStepSuggestion,
  nextStepContextFromEntities,
  type CampaignIntent,
  type NextStepContext,
} from "./index.js";

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

describe("pickGrowthMove — escolhe UM movimento de crescimento (S1, forward-looking)", () => {
  const none: NextStepContext = { hasScalableWinner: false, hasSaturatedWinner: false, hasAgingCreative: false };

  it("nada acionável → null (degrada em silêncio)", () => {
    expect(pickGrowthMove(none)).toBeNull();
    expect(nextStepSuggestion(none)).toBeNull();
  });

  it("vencedor com espaço → escalar (movimento de maior alavanca)", () => {
    expect(pickGrowthMove({ ...none, hasScalableWinner: true })).toBe("scale_winner");
  });

  it("vencedor saturado → testar público novo (cresce horizontal, não subindo verba)", () => {
    expect(pickGrowthMove({ ...none, hasSaturatedWinner: true })).toBe("test_audience");
  });

  it("criativo envelhecendo (ainda entrega) → preparar o próximo criativo", () => {
    expect(pickGrowthMove({ ...none, hasAgingCreative: true })).toBe("refresh_creative");
  });

  it("escalar tem prioridade sobre saturação e criativo (vencedor fresco é o maior salto)", () => {
    expect(pickGrowthMove({ hasScalableWinner: true, hasSaturatedWinner: true, hasAgingCreative: true })).toBe("scale_winner");
  });

  it("saturação tem prioridade sobre criativo envelhecendo (só cresce por público novo)", () => {
    expect(pickGrowthMove({ hasScalableWinner: false, hasSaturatedWinner: true, hasAgingCreative: true })).toBe("test_audience");
  });
});

describe("nextStepContextFromEntities — deriva os sinais do brief (core decide)", () => {
  const base = (over: Partial<EntitySummary>): EntitySummary =>
    ({
      id: "e1",
      level: "campaign",
      name: "C",
      status: "active",
      metrics: {},
      deltaVsBaseline: {},
      flags: [],
      ...over,
    }) as EntitySummary;

  const significant = { hasSignificance: true, inLearning: false, conversions: 30, clicks: 300 };

  it("winner provado com folga → hasScalableWinner", () => {
    const ctx = nextStepContextFromEntities([base({ tier: "winner", eligibility: significant })]);
    expect(ctx.hasScalableWinner).toBe(true);
    expect(ctx.hasSaturatedWinner).toBe(false);
  });

  it("winner que saturou o público → hasSaturatedWinner (não conta como escalável)", () => {
    const ctx = nextStepContextFromEntities([
      base({ tier: "winner", eligibility: significant, healthSignals: ["audience_saturation"] }),
    ]);
    expect(ctx.hasSaturatedWinner).toBe(true);
    expect(ctx.hasScalableWinner).toBe(false);
  });

  it("winner em learning ou sem significância NÃO é escalável (protege o guard de escala)", () => {
    const inLearning = nextStepContextFromEntities([
      base({ tier: "winner", eligibility: { ...significant, inLearning: true } }),
    ]);
    expect(inLearning.hasScalableWinner).toBe(false);
    const noSig = nextStepContextFromEntities([
      base({ tier: "winner", eligibility: { ...significant, hasSignificance: false } }),
    ]);
    expect(noSig.hasScalableWinner).toBe(false);
  });

  it("creative_aging em qualquer entidade → hasAgingCreative", () => {
    const ctx = nextStepContextFromEntities([base({ level: "ad", healthSignals: ["creative_aging"] })]);
    expect(ctx.hasAgingCreative).toBe(true);
  });

  it("lista vazia → tudo false (nextStep degrada em silêncio)", () => {
    const ctx = nextStepContextFromEntities([]);
    expect(nextStepSuggestion(ctx)).toBeNull();
  });
});

describe("nextStepSuggestion — linha proativa (1-2 linhas, negócio, sem jargão)", () => {
  it("cada movimento retorna texto forward-looking, sem sigla crua e sem travessão dramático", () => {
    const ctxs: NextStepContext[] = [
      { hasScalableWinner: true, hasSaturatedWinner: false, hasAgingCreative: false },
      { hasScalableWinner: false, hasSaturatedWinner: true, hasAgingCreative: false },
      { hasScalableWinner: false, hasSaturatedWinner: false, hasAgingCreative: true },
    ];
    for (const ctx of ctxs) {
      const line = nextStepSuggestion(ctx);
      expect(line).not.toBeNull();
      expect(line!.length).toBeGreaterThan(0);
      // linguagem de negócio: nunca a sigla técnica crua no que vai pro dono
      expect(line).not.toContain("CBO");
      expect(line).not.toContain("ABO");
      // sem travessão dramático como conector (cara de IA)
      expect(line).not.toContain(" — ");
    }
  });
});
