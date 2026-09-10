import { describe, expect, it } from "vitest";
import type { EntitySummary } from "@trafego/shared";
import {
  DEFAULT_QUALITY_THRESHOLDS as T,
  classifyTier,
  computeEligibility,
  detectCreativeWeakness,
  detectHealthSignals,
  enrichEntitiesQuality,
  resolveFrequencyCap,
} from "./index.js";

describe("resolveFrequencyCap (Fase 4 — teto de escala por audiência)", () => {
  it("remarketing → teto de remarketing; prospecting/unknown → teto de prospecção; sem estágio → teto geral", () => {
    expect(resolveFrequencyCap("remarketing", T)).toBe(T.frequencyCapByStage.remarketing);
    expect(resolveFrequencyCap("prospecting", T)).toBe(T.frequencyCapByStage.prospecting);
    expect(resolveFrequencyCap("unknown", T)).toBe(T.frequencyCapByStage.prospecting);
    expect(resolveFrequencyCap(undefined, T)).toBe(T.fatigueFrequency);
  });
});

describe("computeEligibility", () => {
  it("significância exige volume E baseline (proxy de ≥ janela)", () => {
    expect(computeEligibility({ conversions: 25, clicks: 10, hasBaseline: true }, T).hasSignificance).toBe(true);
    expect(computeEligibility({ conversions: 200, clicks: 0, hasBaseline: false }, T).hasSignificance).toBe(false);
    expect(computeEligibility({ conversions: 2, clicks: 40, hasBaseline: true }, T).hasSignificance).toBe(false);
  });
  it("sem baseline = em learning (entidade nova)", () => {
    expect(computeEligibility({ conversions: 0, clicks: 0, hasBaseline: false }, T).inLearning).toBe(true);
    expect(computeEligibility({ conversions: 30, clicks: 0, hasBaseline: true }, T).inLearning).toBe(false);
  });

  it("conversation_started conta como volume quando basis=proxy (S3)", () => {
    expect(
      computeEligibility(
        { conversions: 0, clicks: 5, hasBaseline: true, conversationStarted: 25, conversionBasis: "proxy" },
        T,
      ).hasSignificance,
    ).toBe(true);
  });
  it("conversation_started NÃO conta quando basis=target (conversão de negócio é mensurável ali)", () => {
    expect(
      computeEligibility(
        { conversions: 0, clicks: 5, hasBaseline: true, conversationStarted: 25, conversionBasis: "target" },
        T,
      ).hasSignificance,
    ).toBe(false);
  });

  it("piso relativo: gasto ≥ 2×targetCPA conta como volume mesmo com poucas conversões (playbook real)", () => {
    expect(
      computeEligibility({ conversions: 2, clicks: 10, hasBaseline: true, targetCPA: 7, spend: 14 }, T)
        .hasSignificance,
    ).toBe(true);
  });
  it("piso relativo: abaixo de 2×targetCPA não basta", () => {
    expect(
      computeEligibility({ conversions: 2, clicks: 10, hasBaseline: true, targetCPA: 7, spend: 13.99 }, T)
        .hasSignificance,
    ).toBe(false);
  });
  it("piso relativo ainda exige hasBaseline (nunca dá significância a entidade em learning)", () => {
    expect(
      computeEligibility({ conversions: 2, clicks: 10, hasBaseline: false, targetCPA: 7, spend: 100 }, T)
        .hasSignificance,
    ).toBe(false);
  });
});

describe("detectHealthSignals", () => {
  it("fadiga = 2+ sinais (CTR caiu + freq alta)", () => {
    const s = detectHealthSignals({ frequency: 3.4, ctrDropPct: 30, costRisePct: 0, hasSignificance: true }, T);
    expect(s).toContain("creative_fatigue");
    expect(s).toContain("audience_saturation");
  });
  it("1 sinal só não é fadiga", () => {
    expect(detectHealthSignals({ ctrDropPct: 30, costRisePct: 0, hasSignificance: true }, T)).not.toContain("creative_fatigue");
  });
  it("desgaste (2+ sinais) num que AINDA ENTREGA (stillDelivering) → creative_aging, não creative_fatigue", () => {
    const s = detectHealthSignals({ frequency: 3.4, ctrDropPct: 30, costRisePct: 0, hasSignificance: true, stillDelivering: true }, T);
    expect(s).toContain("creative_aging");
    expect(s).not.toContain("creative_fatigue");
  });
  it("desgaste (2+ sinais) num que já NÃO entrega → creative_fatigue (troque)", () => {
    const s = detectHealthSignals({ frequency: 3.4, ctrDropPct: 30, costRisePct: 0, hasSignificance: true, stillDelivering: false }, T);
    expect(s).toContain("creative_fatigue");
    expect(s).not.toContain("creative_aging");
  });
  it("stillDelivering ausente → conservador (creative_fatigue), nunca aging por omissão", () => {
    const s = detectHealthSignals({ frequency: 3.4, ctrDropPct: 30, costRisePct: 0, hasSignificance: true }, T);
    expect(s).toContain("creative_fatigue");
    expect(s).not.toContain("creative_aging");
  });
  it("sem significância → low_volume", () => {
    expect(detectHealthSignals({ ctrDropPct: 0, costRisePct: 0, hasSignificance: false }, T)).toContain("low_volume");
  });
  it("frequencyCap por estágio sobrepõe o teto geral", () => {
    // freq 2.6 satura na prospecção (cap 2.5) mas não no remarketing (cap 8).
    expect(
      detectHealthSignals({ frequency: 2.6, ctrDropPct: 0, costRisePct: 0, hasSignificance: true, frequencyCap: 2.5 }, T),
    ).toContain("audience_saturation");
    expect(
      detectHealthSignals({ frequency: 2.6, ctrDropPct: 0, costRisePct: 0, hasSignificance: true, frequencyCap: 8 }, T),
    ).not.toContain("audience_saturation");
  });

  it("S6: videoHookRetentionPct abaixo do limiar → weak_hook_retention", () => {
    expect(
      detectHealthSignals({ ctrDropPct: 0, costRisePct: 0, hasSignificance: true, videoHookRetentionPct: 10 }, T),
    ).toContain("weak_hook_retention");
  });
  it("S6: videoHookRetentionPct acima do limiar → sem sinal", () => {
    expect(
      detectHealthSignals({ ctrDropPct: 0, costRisePct: 0, hasSignificance: true, videoHookRetentionPct: 90 }, T),
    ).not.toContain("weak_hook_retention");
  });
  it("S6: sem videoHookRetentionPct (ad sem vídeo) → sem sinal (honesto, não assume fraco)", () => {
    expect(detectHealthSignals({ ctrDropPct: 0, costRisePct: 0, hasSignificance: true }, T)).not.toContain(
      "weak_hook_retention",
    );
  });

  it("S6: qualityRankings com QUALQUER ranking below_average → platform_quality_below_average", () => {
    expect(
      detectHealthSignals(
        { ctrDropPct: 0, costRisePct: 0, hasSignificance: true, qualityRankings: { engagement: "below_average" } },
        T,
      ),
    ).toContain("platform_quality_below_average");
  });
  it("S6: qualityRankings todos average/above/unknown → sem sinal", () => {
    expect(
      detectHealthSignals(
        { ctrDropPct: 0, costRisePct: 0, hasSignificance: true, qualityRankings: { quality: "average", engagement: "above_average", conversion: "unknown" } },
        T,
      ),
    ).not.toContain("platform_quality_below_average");
  });
});

describe("detectCreativeWeakness (S4b — prova fraca + baixa densidade persuasiva)", () => {
  it("weak_creative: proofStrength=weak E persuasionSignals<3 (limiar do próprio Cialdini)", () => {
    expect(detectCreativeWeakness("weak", 2)).toEqual(["weak_creative"]);
    expect(detectCreativeWeakness("weak", 0)).toEqual(["weak_creative"]);
  });
  it("proofStrength=weak mas persuasionSignals>=3 → sem sinal (persuasão presente compensa)", () => {
    expect(detectCreativeWeakness("weak", 3)).toEqual([]);
  });
  it("proofStrength medium/strong → nunca weak_creative, mesmo com persuasionSignals baixo", () => {
    expect(detectCreativeWeakness("medium", 0)).toEqual([]);
    expect(detectCreativeWeakness("strong", 0)).toEqual([]);
  });
  it("persuasionSignals ausente → sem sinal (honesto: sem dado suficiente, não assume fraco)", () => {
    expect(detectCreativeWeakness("weak", undefined)).toEqual([]);
  });
  it("proofStrength ausente → sem sinal", () => {
    expect(detectCreativeWeakness(undefined, 0)).toEqual([]);
  });
});

describe("classifyTier", () => {
  const base = { hasSignificance: true, beatsTarget: false, belowTarget: false, worseThanBaseline: false, topEfficiencyNoTarget: false, hasSignOfLife: true, inLearning: false };
  it("zombie: gastou e sem NENHUM sinal de vida, fora de learning (independe de significância)", () => {
    expect(classifyTier({ ...base, conversions: 0, spend: 200, hasSignOfLife: false, hasSignificance: false }, T)).toBe("zombie");
  });
  it("com sinal de vida (conversa/proxy) NÃO é zumbi mesmo com 0 conversão de negócio", () => {
    expect(classifyTier({ ...base, conversions: 0, spend: 200, hasSignOfLife: true, hasSignificance: false }, T)).toBeUndefined();
  });
  it("em learning nunca é zumbi", () => {
    expect(classifyTier({ ...base, conversions: 0, spend: 200, hasSignOfLife: false, inLearning: true, hasSignificance: false }, T)).toBeUndefined();
  });
  it("sem significância (não-zombie) → sem tier", () => {
    expect(classifyTier({ ...base, conversions: 3, spend: 200, hasSignificance: false }, T)).toBeUndefined();
  });
  it("bate meta → winner; abaixo da meta → underperformer", () => {
    expect(classifyTier({ ...base, conversions: 30, spend: 200, beatsTarget: true }, T)).toBe("winner");
    expect(classifyTier({ ...base, conversions: 30, spend: 200, belowTarget: true }, T)).toBe("underperformer");
  });
  it("default significante = performer", () => {
    expect(classifyTier({ ...base, conversions: 30, spend: 200 }, T)).toBe("performer");
  });
});

function summary(over: Partial<EntitySummary> & { id: string }): EntitySummary {
  return {
    level: "campaign",
    name: over.id,
    status: "active",
    metrics: { spend: 100, impressions: 5000, clicks: 150, ctr: 2.5, cpc: 0.67, cpm: 20 },
    deltaVsBaseline: { ctr: 0 },
    flags: [],
    conversionBasis: "target",
    ...over,
  };
}

describe("enrichEntitiesQuality (integração das peças)", () => {
  it("marca zombie e anexa eligibility/healthSignals", () => {
    const out = enrichEntitiesQuality(
      [summary({ id: "Z", metrics: { spend: 300, impressions: 9000, clicks: 40, ctr: 0.4, cpc: 7.5, cpm: 33, conversions: 0 }, deltaVsBaseline: { ctr: 0 } })],
      {},
      { thresholds: T, hasTarget: false, currency: "BRL" },
    );
    expect(out[0]!.tier).toBe("zombie");
    expect(out[0]!.eligibility).toBeDefined();
  });

  it("winner por bater a meta de CPA", () => {
    const out = enrichEntitiesQuality(
      [summary({ id: "W", metrics: { spend: 400, impressions: 20000, clicks: 500, ctr: 2.5, cpc: 0.8, cpm: 20, conversions: 40, cpa: 10 }, deltaVsBaseline: { ctr: 0.1 } })],
      { targetCPA: 15 },
      { thresholds: T, hasTarget: true, currency: "BRL" },
    );
    expect(out[0]!.tier).toBe("winner");
  });

  it("vencedor desgastando MAS ainda batendo a meta → creative_aging + tier winner (não creative_fatigue)", () => {
    // 2 sinais de desgaste (CTR -25%, CPA +50% vs baseline) mas CPA 12 ainda < meta 15 → aging, não fatigue.
    const [w] = enrichEntitiesQuality(
      [
        summary({
          id: "AGING",
          metrics: { spend: 480, impressions: 20000, clicks: 400, ctr: 6, cpc: 1.2, cpm: 24, frequency: 1.2, conversions: 40, cpa: 12 },
          deltaVsBaseline: { ctr: -2, cpa: 4 },
        }),
      ],
      { targetCPA: 15 },
      { thresholds: T, hasTarget: true, currency: "BRL" },
    );
    expect(w?.tier).toBe("winner");
    expect(w?.healthSignals ?? []).toContain("creative_aging");
    expect(w?.healthSignals ?? []).not.toContain("creative_fatigue");
  });

  it("mesma deterioração num que já NÃO bate a meta → creative_fatigue (troque)", () => {
    const [u] = enrichEntitiesQuality(
      [
        summary({
          id: "FATIGUED",
          metrics: { spend: 480, impressions: 20000, clicks: 400, ctr: 6, cpc: 1.2, cpm: 24, frequency: 1.2, conversions: 40, cpa: 20 },
          deltaVsBaseline: { ctr: -2, cpa: 6 },
          flags: ["cpa_acima_da_meta"],
        }),
      ],
      { targetCPA: 15 },
      { thresholds: T, hasTarget: true, currency: "BRL" },
    );
    expect(u?.healthSignals ?? []).toContain("creative_fatigue");
    expect(u?.healthSignals ?? []).not.toContain("creative_aging");
  });

  it("conta de mensagem vira significante/winner por conversas (basis=proxy) mesmo com poucas conversões absolutas (S3)", () => {
    const out = enrichEntitiesQuality(
      [
        summary({
          id: "MSG",
          metrics: { spend: 200, impressions: 10000, clicks: 300, ctr: 3, cpc: 0.67, cpm: 20, conversions: 0 },
          conversionBasis: "proxy",
          funnel: { counts: { conversation_started: 30 } },
        }),
      ],
      {},
      { thresholds: T, hasTarget: false, currency: "BRL" },
    );
    expect(out[0]!.eligibility?.hasSignificance).toBe(true);
  });

  it("piso relativo integrado: gasto ≥ 2×targetCPA vira significante mesmo com poucas conversões", () => {
    const out = enrichEntitiesQuality(
      [
        summary({
          id: "REL",
          metrics: { spend: 14, impressions: 2000, clicks: 12, ctr: 0.6, cpc: 1.17, cpm: 7, conversions: 1, cpa: 14 },
        }),
      ],
      { targetCPA: 7 },
      { thresholds: T, hasTarget: true, currency: "BRL" },
    );
    expect(out[0]!.eligibility?.hasSignificance).toBe(true);
  });

  it("frequência por estágio: prospecção satura a 2,6; remarketing não", () => {
    const met = { spend: 100, impressions: 5000, clicks: 150, ctr: 2.5, cpc: 0.67, cpm: 20, frequency: 2.6, conversions: 30 };
    const [prospect] = enrichEntitiesQuality(
      [summary({ id: "P", level: "adset", metrics: met, audience: { stage: "prospecting", customAudienceCount: 0, exclusionCount: 0, expansion: { summary: "unknown" } } })],
      {},
      { thresholds: T, hasTarget: false, currency: "BRL" },
    );
    const [remarket] = enrichEntitiesQuality(
      [summary({ id: "R", level: "adset", metrics: met, audience: { stage: "remarketing", customAudienceCount: 1, exclusionCount: 0, expansion: { summary: "unknown" } } })],
      {},
      { thresholds: T, hasTarget: false, currency: "BRL" },
    );
    expect(prospect!.healthSignals ?? []).toContain("audience_saturation");
    expect(remarket!.healthSignals ?? []).not.toContain("audience_saturation");
  });

  it("S6: repassa videoHookRetentionPct (metrics) e qualityRankings (entidade) pro detector", () => {
    const out = enrichEntitiesQuality(
      [
        summary({
          id: "V",
          metrics: { spend: 100, impressions: 5000, clicks: 150, ctr: 2.5, cpc: 0.67, cpm: 20, videoHookRetentionPct: 5 },
          qualityRankings: { quality: "below_average" },
        }),
      ],
      {},
      { thresholds: T, hasTarget: false, currency: "BRL" },
    );
    expect(out[0]!.healthSignals ?? []).toContain("weak_hook_retention");
    expect(out[0]!.healthSignals ?? []).toContain("platform_quality_below_average");
  });
});
