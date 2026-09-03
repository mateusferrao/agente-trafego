import { describe, expect, it } from "vitest";
import type { HealthSignal } from "@trafego/shared";
import { firstFatigueSignal, isFatigued } from "./index.js";

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

  it("undefined/vazio → false", () => {
    expect(isFatigued(undefined)).toBe(false);
    expect(isFatigued([])).toBe(false);
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
