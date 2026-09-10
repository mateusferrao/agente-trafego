import { describe, expect, it } from "vitest";
import { assessCreativePick, WEAK_PERSUASION_MAX, type CreativePickSignals } from "./creative-critique.js";

const base: CreativePickSignals = {
  fatigued: false,
  aging: false,
  stageMismatch: false,
  campaignStage: "remarketing",
  poolHasNoAcceptableFit: false,
};

describe("assessCreativePick — veredito determinístico + vaso de honestidade", () => {
  it("pick bom (sem fraqueza) → solid, sem ressalva nem recomendação (respeita autonomia)", () => {
    const c = assessCreativePick({ ...base, proofStrength: "strong", persuasionSignals: 4 });
    expect(c.verdict).toBe("solid");
    expect(c.ressalva).toBeUndefined();
    expect(c.recommendation).toBeUndefined();
  });

  it("nada casa (pool sem fit aceitável) → recommend_new (human_direction), sem ressalva", () => {
    const c = assessCreativePick({ ...base, poolHasNoAcceptableFit: true });
    expect(c.verdict).toBe("recommend_new");
    expect(c.reason).toBe("no_fit");
    expect(c.ressalva).toBeUndefined();
    expect(c.recommendation).toContain("criar um novo");
  });

  it("pick fadigado DURO (não aging) → recommend_new (não embarca criativo morto)", () => {
    const c = assessCreativePick({ ...base, fatigued: true, aging: false });
    expect(c.verdict).toBe("recommend_new");
    expect(c.reason).toBe("fatigued");
    expect(c.ressalva).toBeUndefined();
  });

  it("pick AGING (ainda entrega) → caveat + Ressalva weak_creative_pick (trava auto-apply, aprovável)", () => {
    const c = assessCreativePick({ ...base, fatigued: true, aging: true });
    expect(c.verdict).toBe("caveat");
    expect(c.reason).toBe("aging_winner");
    expect(c.ressalva?.code).toBe("weak_creative_pick");
    expect(c.ressalva?.message).toContain("ainda entrega");
    expect(c.recommendation).toBe(c.ressalva?.message);
  });

  it("cross-stage (criativo de estágio oposto) → caveat com Ressalva + menciona o público-alvo", () => {
    const c = assessCreativePick({ ...base, stageMismatch: true, campaignStage: "remarketing" });
    expect(c.verdict).toBe("caveat");
    expect(c.reason).toBe("cross_stage");
    expect(c.ressalva?.message).toContain("remarketing");
  });

  it("prova fraca (proofStrength weak) → caveat weak_proof", () => {
    const c = assessCreativePick({ ...base, proofStrength: "weak" });
    expect(c.verdict).toBe("caveat");
    expect(c.reason).toBe("weak_proof");
    expect(c.ressalva?.code).toBe("weak_creative_pick");
  });

  it("persuasão fina (<= WEAK_PERSUASION_MAX) → caveat weak_proof", () => {
    const c = assessCreativePick({ ...base, persuasionSignals: WEAK_PERSUASION_MAX });
    expect(c.verdict).toBe("caveat");
    expect(c.reason).toBe("weak_proof");
  });

  it("severidade: aging vence stageMismatch vence weak_proof (um motivo por vez)", () => {
    const c = assessCreativePick({ ...base, aging: true, fatigued: true, stageMismatch: true, proofStrength: "weak" });
    expect(c.reason).toBe("aging_winner");
  });
});
