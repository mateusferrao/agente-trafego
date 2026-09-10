import { describe, expect, it } from "vitest";
import type { HealthSignal } from "@trafego/shared";
import { firstFatigueSignal, hasHardFatigue, isAging, isFatigued } from "./index.js";

// Fonte única de "fadiga de criativo" — reconcilia o guard de escala (que já usava
// creative_fatigue + weak_hook_retention) com o detector de oportunidade de criação
// (que antes só olhava creative_fatigue, gerando escala contraditória no MESMO vencedor).
describe("isFatigued (sinal DURO de fadiga de criativo)", () => {
  it("creative_fatigue → true", () => {
    expect(isFatigued(["creative_fatigue"])).toBe(true);
  });

  it("weak_hook_retention → true (o bug: o detector de escala ignorava esse sinal)", () => {
    expect(isFatigued(["weak_hook_retention"])).toBe(true);
  });

  it("mistura com sinal duro → true", () => {
    expect(isFatigued(["low_volume", "weak_hook_retention"])).toBe(true);
  });

  it("só sinais que não são fadiga → false", () => {
    expect(isFatigued(["low_volume", "audience_saturation"])).toBe(false);
  });

  it("weak_creative (score de visão, LLM soft) → false — nunca é critério de fadiga dura", () => {
    expect(isFatigued(["weak_creative"])).toBe(false);
  });

  it("creative_aging → true (desgaste ainda trava escala/duplicação; só a direção da rec muda)", () => {
    expect(isFatigued(["creative_aging"])).toBe(true);
  });

  it("undefined/vazio → false", () => {
    expect(isFatigued(undefined)).toBe(false);
    expect(isFatigued([])).toBe(false);
  });
});

describe("isAging (desgaste que AINDA entrega — distingue a direção da rec)", () => {
  it("creative_aging → true", () => expect(isAging(["creative_aging"])).toBe(true));
  it("creative_fatigue (já não entrega) → false", () => expect(isAging(["creative_fatigue"])).toBe(false));
  it("weak_hook_retention → false", () => expect(isAging(["weak_hook_retention"])).toBe(false));
  it("undefined/vazio → false", () => {
    expect(isAging(undefined)).toBe(false);
    expect(isAging([])).toBe(false);
  });
});

describe("hasHardFatigue (desgaste DURO que não é só aging — 'a dura vence')", () => {
  it("creative_fatigue → true", () => expect(hasHardFatigue(["creative_fatigue"])).toBe(true));
  it("weak_hook_retention → true", () => expect(hasHardFatigue(["weak_hook_retention"])).toBe(true));
  it("só creative_aging → false (aging benigno, ainda entrega)", () => expect(hasHardFatigue(["creative_aging"])).toBe(false));
  it("O CASO REAL: creative_aging + weak_hook_retention JUNTOS → true (a dura não é mascarada pelo aging)", () => {
    expect(hasHardFatigue(["creative_aging", "weak_hook_retention"])).toBe(true);
  });
  it("sem fadiga → false", () => {
    expect(hasHardFatigue(["low_volume"])).toBe(false);
    expect(hasHardFatigue(undefined)).toBe(false);
  });
});

describe("firstFatigueSignal (o sinal específico, p/ a mensagem do guard)", () => {
  it("retorna o primeiro sinal duro presente", () => {
    const signals: readonly HealthSignal[] = ["low_volume", "weak_hook_retention", "creative_fatigue"];
    expect(firstFatigueSignal(signals)).toBe("weak_hook_retention");
  });

  it("sem sinal duro → undefined", () => {
    expect(firstFatigueSignal(["low_volume"])).toBeUndefined();
  });
});
