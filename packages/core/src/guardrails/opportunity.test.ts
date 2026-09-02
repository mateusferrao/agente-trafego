import { describe, expect, it } from "vitest";
import { detectGuardrailOpportunity } from "./index.js";

describe("detectGuardrailOpportunity", () => {
  const raise = { wantedPct: 50, cappedPct: 20, currentBudgetMinor: 100_00 }; // R$100/dia

  it("emite quando as 3 condições batem (clamp real + prior de escala + R$ material)", () => {
    const op = detectGuardrailOpportunity({ clampedRaises: [raise], hasScalePaysPrior: true, minMaterialMinor: 10_00 });
    expect(op).not.toBeNull();
    expect(op?.threshold).toBe("maxBudgetChangePct");
    expect(op?.wantedPct).toBe(50);
    expect(op?.cappedPct).toBe(20);
    // R$ bloqueado ~ 100 * (50-20)% = R$30/dia (3000 na unidade mínima).
    expect(op?.foregoneMinor).toBe(30_00);
  });

  it("NÃO emite sem prior de escala medido (hard-wall: aprendizado não empurra teto sozinho)", () => {
    expect(detectGuardrailOpportunity({ clampedRaises: [raise], hasScalePaysPrior: false, minMaterialMinor: 10_00 })).toBeNull();
  });

  it("NÃO emite quando o R$ bloqueado é imaterial", () => {
    const small = { wantedPct: 25, cappedPct: 20, currentBudgetMinor: 10_00 }; // R$0,50/dia bloqueado
    expect(detectGuardrailOpportunity({ clampedRaises: [small], hasScalePaysPrior: true, minMaterialMinor: 10_00 })).toBeNull();
  });

  it("NÃO emite quando o guardrail não clampou nada (proposto <= teto)", () => {
    const noclamp = { wantedPct: 15, cappedPct: 20, currentBudgetMinor: 100_00 };
    expect(detectGuardrailOpportunity({ clampedRaises: [noclamp], hasScalePaysPrior: true, minMaterialMinor: 10_00 })).toBeNull();
  });

  it("escolhe a MAIOR oportunidade (mais R$ na mesa)", () => {
    const big = { wantedPct: 60, cappedPct: 20, currentBudgetMinor: 200_00 };
    const op = detectGuardrailOpportunity({ clampedRaises: [raise, big], hasScalePaysPrior: true, minMaterialMinor: 10_00 });
    expect(op?.foregoneMinor).toBe(80_00); // 200 * 40% = R$80/dia
  });
});
