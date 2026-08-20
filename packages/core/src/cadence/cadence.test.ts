import { describe, it, expect } from "vitest";
import type { CadenceSpec } from "@trafego/shared";
import { cadenceToCron } from "./index.js";

describe("cadenceToCron", () => {
  it("diária → minuto 0 na hora escolhida", () => {
    expect(cadenceToCron({ kind: "daily", hour: 8 })).toBe("0 8 * * *");
    expect(cadenceToCron({ kind: "daily", hour: 0 })).toBe("0 0 * * *");
  });

  it("2× ao dia → duas horas ordenadas e sem duplicata", () => {
    expect(cadenceToCron({ kind: "twice_daily", hours: [8, 20] })).toBe("0 8,20 * * *");
    // fora de ordem → ordena
    expect(cadenceToCron({ kind: "twice_daily", hours: [20, 8] })).toBe("0 8,20 * * *");
    // horas iguais → colapsa a uma (equivale a diária)
    expect(cadenceToCron({ kind: "twice_daily", hours: [8, 8] })).toBe("0 8 * * *");
  });

  it("semanal → dia da semana (cron dow) na hora escolhida", () => {
    expect(cadenceToCron({ kind: "weekly", weekday: 1, hour: 8 })).toBe("0 8 * * 1");
    expect(cadenceToCron({ kind: "weekly", weekday: 0, hour: 22 })).toBe("0 22 * * 0");
  });

  it("raw → passa o cron cru sem alterar (escape do avançado)", () => {
    const spec: CadenceSpec = { kind: "raw", cron: "*/30 9-18 * * 1-5" };
    expect(cadenceToCron(spec)).toBe("*/30 9-18 * * 1-5");
  });
});
