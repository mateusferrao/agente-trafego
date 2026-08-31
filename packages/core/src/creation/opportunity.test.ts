import { describe, expect, it } from "vitest";
import { detectCreationOpportunities, type OpportunityEntity } from "./opportunity.js";

function ent(over: Partial<OpportunityEntity> = {}): OpportunityEntity {
  return {
    id: "e1",
    level: "adset",
    name: "Adset 1",
    significant: true,
    atBudgetCeiling: false,
    fatigued: false,
    spending: true,
    ...over,
  };
}

describe("detectCreationOpportunities", () => {
  it("scale_winner: vencedor significativo no teto de budget", () => {
    const out = detectCreationOpportunities({
      hasActiveCampaigns: true,
      entities: [ent({ tier: "winner", atBudgetCeiling: true })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("scale_winner");
    expect(out[0]?.entityId).toBe("e1");
  });

  it("vencedor com FOLGA de budget → replicate_winner (replicar pra público novo, não subir budget)", () => {
    const out = detectCreationOpportunities({
      hasActiveCampaigns: true,
      entities: [ent({ tier: "winner", atBudgetCeiling: false })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("replicate_winner");
    expect(out[0]?.entityId).toBe("e1");
  });

  it("remarketing: conta com público de convertidos + tráfego ativo", () => {
    const out = detectCreationOpportunities({ hasActiveCampaigns: true, hasConverterAudience: true, entities: [] });
    expect(out.some((o) => o.kind === "remarketing")).toBe(true);
  });

  it("prospecting_expansion: público saturado ainda gastando", () => {
    const out = detectCreationOpportunities({ hasActiveCampaigns: true, entities: [ent({ saturated: true, spending: true })] });
    expect(out[0]?.kind).toBe("prospecting_expansion");
  });

  it("scale vence remarketing e replicate (prioridade top-1)", () => {
    const out = detectCreationOpportunities({
      hasActiveCampaigns: true,
      hasConverterAudience: true,
      entities: [ent({ tier: "winner", atBudgetCeiling: true })],
    });
    expect(out[0]?.kind).toBe("scale_winner");
  });

  it("escala vencedor provado quando o teto é desconhecido (atBudgetCeiling undefined → propõe pro humano)", () => {
    const { atBudgetCeiling: _omit, ...rest } = ent({ tier: "winner" });
    const out = detectCreationOpportunities({ hasActiveCampaigns: true, entities: [rest] });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("scale_winner");
  });

  it("refresh_fatigued: fatigado ainda gastando", () => {
    const out = detectCreationOpportunities({
      hasActiveCampaigns: true,
      entities: [ent({ fatigued: true, spending: true })],
    });
    expect(out[0]?.kind).toBe("refresh_fatigued");
  });

  it("cold_start quando não há campanha ativa", () => {
    const out = detectCreationOpportunities({ hasActiveCampaigns: false, entities: [] });
    expect(out).toEqual([{ kind: "cold_start", rationale: expect.any(String) }]);
  });

  it("vencedor FATIGADO no teto → NÃO propõe scale_winner (criativo cansado); refresh_fatigued vira o top (gap real corrigido)", () => {
    const out = detectCreationOpportunities({
      hasActiveCampaigns: true,
      entities: [ent({ tier: "winner", atBudgetCeiling: true, fatigued: true })],
    });
    expect(out.some((o) => o.kind === "scale_winner")).toBe(false);
    expect(out[0]?.kind).toBe("refresh_fatigued");
  });

  it("vencedor fatigado COM FOLGA de budget → replicate_winner ainda vale (público novo, criativo provado, não é 'mais do mesmo cansado')", () => {
    const out = detectCreationOpportunities({
      hasActiveCampaigns: true,
      entities: [ent({ tier: "winner", atBudgetCeiling: false, fatigued: true })],
    });
    expect(out.some((o) => o.kind === "replicate_winner")).toBe(true);
  });

  it("prioridade: scale > refresh > cold_start", () => {
    const out = detectCreationOpportunities({
      hasActiveCampaigns: false,
      entities: [
        ent({ id: "f", fatigued: true }),
        ent({ id: "w", tier: "winner", atBudgetCeiling: true }),
      ],
    });
    expect(out.map((o) => o.kind)).toEqual(["scale_winner", "refresh_fatigued", "cold_start"]);
  });
});
