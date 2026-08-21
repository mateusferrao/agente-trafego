import { describe, expect, it } from "vitest";
import { benchmarkFor, ctrRating, outcomeKindFor } from "./index.js";

describe("outcomeKindFor", () => {
  it("mapeia a conversão de negócio p/ grupo de custo", () => {
    expect(outcomeKindFor("messaging_started")).toBe("conversation");
    expect(outcomeKindFor("lead")).toBe("lead");
    expect(outcomeKindFor("purchase")).toBe("sale");
    expect(outcomeKindFor("view_content")).toBeUndefined();
    expect(outcomeKindFor(undefined)).toBeUndefined();
  });
});

describe("ctrRating", () => {
  it("classifica o CTR (%) em faixas direcionais", () => {
    expect(ctrRating(0.5)).toBe("ruim");
    expect(ctrRating(1.0)).toBe("ok");
    expect(ctrRating(2.0)).toBe("bom");
    expect(ctrRating(2.53)).toBe("otimo"); // Steticos real
  });
});

describe("benchmarkFor", () => {
  it("fora do cold-start não produz referência (a meta/histórico manda)", () => {
    expect(benchmarkFor({ ctr: 0.5, currency: "BRL", coldStart: false })).toEqual({ coldStart: false });
  });

  it("no cold-start dá rating de CTR + faixa de custo do tipo de conversão", () => {
    const ref = benchmarkFor({ ctr: 2.53, frequency: 2.6, outcomeGoal: "messaging_started", currency: "BRL", coldStart: true });
    expect(ref.coldStart).toBe(true);
    expect(ref.ctrRating).toBe("otimo");
    expect(ref.frequencyAlert).toBe(true); // 2.6 > 2.5
    expect(ref.costReference).toEqual({ label: "custo por conversa", min: 3, max: 15, currency: "BRL" });
  });

  it("sem conversão mapeável, omite a faixa de custo", () => {
    const ref = benchmarkFor({ ctr: 1.0, outcomeGoal: "view_content", currency: "BRL", coldStart: true });
    expect(ref.costReference).toBeUndefined();
    expect(ref.ctrRating).toBe("ok");
  });
});
