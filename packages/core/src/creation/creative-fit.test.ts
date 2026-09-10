import { describe, expect, it } from "vitest";
import { CREATIVE_FIT_WEIGHTS, isOppositeStage, orderCandidatesByFit, scoreCreativeFit, type CreativeFitCandidate, type CreativeFitContext } from "./creative-fit.js";

const cand = (over: Partial<CreativeFitCandidate> & { id: string }): CreativeFitCandidate => ({ ...over });

describe("isOppositeStage", () => {
  it("prospecção × remarketing são opostos; unknown nunca é oposto; igual não é oposto", () => {
    expect(isOppositeStage("prospecting", "remarketing")).toBe(true);
    expect(isOppositeStage("remarketing", "prospecting")).toBe(true);
    expect(isOppositeStage("prospecting", "prospecting")).toBe(false);
    expect(isOppositeStage("prospecting", "unknown")).toBe(false);
    expect(isOppositeStage("unknown", "remarketing")).toBe(false);
  });
});

describe("scoreCreativeFit — sinais determinísticos", () => {
  const remarketingSale: CreativeFitContext = { campaignStage: "remarketing", goal: "purchase" };

  it("estágio igual + objetivo igual → soma os bônus", () => {
    const r = scoreCreativeFit(cand({ id: "a", originStage: "remarketing", originGoal: "purchase" }), remarketingSale);
    expect(r.stageMatch).toBe(true);
    expect(r.stageMismatch).toBe(false);
    expect(r.score).toBe(CREATIVE_FIT_WEIGHTS.stageMatch + CREATIVE_FIT_WEIGHTS.goalMatch);
  });

  it("O CASO REAL: campanha de remarketing + criativo de prospecção fria → rebaixa forte (stageMismatch)", () => {
    const r = scoreCreativeFit(cand({ id: "cold", originStage: "prospecting", originGoal: "purchase" }), remarketingSale);
    expect(r.stageMismatch).toBe(true);
    expect(r.score).toBe(CREATIVE_FIT_WEIGHTS.stageMismatch + CREATIVE_FIT_WEIGHTS.goalMatch);
  });

  it("estágio/objetivo desconhecido → neutro (0), nunca penaliza", () => {
    const r = scoreCreativeFit(cand({ id: "x" }), remarketingSale);
    expect(r.stageMatch).toBe(false);
    expect(r.stageMismatch).toBe(false);
    expect(r.goalMismatch).toBe(false);
    expect(r.score).toBe(0);
  });

  it("campanha com estágio unknown → não pontua estágio", () => {
    const r = scoreCreativeFit(cand({ id: "a", originStage: "remarketing" }), { campaignStage: "unknown", goal: "purchase" });
    expect(r.stageMatch).toBe(false);
    expect(r.stageMismatch).toBe(false);
  });

  it("objetivo de grupo diferente (venda × conversa) → goalMismatch", () => {
    const r = scoreCreativeFit(cand({ id: "a", originGoal: "messaging_started" }), { campaignStage: "unknown", goal: "purchase" });
    expect(r.goalMismatch).toBe(true);
    expect(r.score).toBe(CREATIVE_FIT_WEIGHTS.goalMismatch);
  });

  it("mesmo grupo de resultado (lead × registration = ambos 'lead') → goalMatch", () => {
    const r = scoreCreativeFit(cand({ id: "a", originGoal: "registration" }), { campaignStage: "unknown", goal: "lead" });
    expect(r.goalMismatch).toBe(false);
    expect(r.score).toBe(CREATIVE_FIT_WEIGHTS.goalMatch);
  });

  it("fadiga rebaixa forte (fecha o gap do pool secundário)", () => {
    const r = scoreCreativeFit(cand({ id: "a", originStage: "remarketing", originGoal: "purchase", healthSignals: ["creative_aging"] }), remarketingSale);
    expect(r.fatigued).toBe(true);
    expect(r.score).toBe(CREATIVE_FIT_WEIGHTS.stageMatch + CREATIVE_FIT_WEIGHTS.goalMatch + CREATIVE_FIT_WEIGHTS.fatigued);
  });
});

describe("orderCandidatesByFit — reordena, não remove; empate = ordem de desempenho", () => {
  const ctx: CreativeFitContext = { campaignStage: "remarketing", goal: "purchase" };

  it("o de fit melhor vem antes do vencedor cru fora de contexto", () => {
    // 'cold' é o 1º (melhor desempenho na ordem de entrada), mas é de prospecção → cai atrás do 'warm'.
    const ordered = orderCandidatesByFit(
      [
        cand({ id: "cold", originStage: "prospecting", originGoal: "purchase" }),
        cand({ id: "warm", originStage: "remarketing", originGoal: "purchase" }),
      ],
      ctx,
    );
    expect(ordered.map((r) => r.candidate.id)).toEqual(["warm", "cold"]);
    expect(ordered).toHaveLength(2); // NÃO removeu ninguém
  });

  it("empate no fit preserva a ordem de entrada (o ranking de desempenho vira o desempate)", () => {
    const ordered = orderCandidatesByFit(
      [
        cand({ id: "first", originStage: "remarketing", originGoal: "purchase" }),
        cand({ id: "second", originStage: "remarketing", originGoal: "purchase" }),
      ],
      ctx,
    );
    expect(ordered.map((r) => r.candidate.id)).toEqual(["first", "second"]);
  });

  it("fadigado desce mesmo com estágio certo", () => {
    const ordered = orderCandidatesByFit(
      [
        cand({ id: "tired", originStage: "remarketing", originGoal: "purchase", healthSignals: ["creative_fatigue"] }),
        cand({ id: "fresh", originStage: "remarketing", originGoal: "purchase" }),
      ],
      ctx,
    );
    expect(ordered.map((r) => r.candidate.id)).toEqual(["fresh", "tired"]);
  });
});
