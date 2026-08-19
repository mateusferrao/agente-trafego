import { describe, expect, it } from "vitest";
import type { ActionType } from "@trafego/shared";
import {
  applicableActionType,
  budgetDirection,
  READ_ONLY_APPLICABILITY,
  riskLevelForActionType,
} from "./index.js";

describe("riskLevelForActionType", () => {
  it("trata pausar como baixo risco (interrompe gasto, reversível)", () => {
    expect(riskLevelForActionType("pause_entity")).toBe("low");
  });

  it("trata ações que (re)ativam gasto como risco médio", () => {
    expect(riskLevelForActionType("resume_entity")).toBe("medium");
    expect(riskLevelForActionType("adjust_budget")).toBe("medium");
    expect(riskLevelForActionType("set_status")).toBe("medium");
  });

  it("é determinístico e cobre todos os ActionType", () => {
    const all: ActionType[] = [
      "pause_entity",
      "resume_entity",
      "adjust_budget",
      "set_status",
    ];
    for (const t of all) {
      expect(riskLevelForActionType(t)).toBe(riskLevelForActionType(t));
      expect(["low", "medium", "high"]).toContain(riskLevelForActionType(t));
    }
  });
});

describe("READ_ONLY_APPLICABILITY", () => {
  it("na fase read-only, nenhuma sugestão é aplicável (aplicação = Fatia 5)", () => {
    expect(READ_ONLY_APPLICABILITY).toBe("not_yet_applicable");
  });
});

describe("applicableActionType", () => {
  it("mapeia sugestões aplicáveis p/ ActionType do sistema", () => {
    expect(applicableActionType("pause")).toBe("pause_entity");
    expect(applicableActionType("resume")).toBe("resume_entity");
    expect(applicableActionType("increase_budget")).toBe("adjust_budget");
    expect(applicableActionType("decrease_budget")).toBe("adjust_budget");
  });

  it("retorna null p/ sugestões consultivas (sem ação tipada)", () => {
    expect(applicableActionType("review_creative")).toBeNull();
    expect(applicableActionType("investigate")).toBeNull();
    expect(applicableActionType("keep")).toBeNull();
  });
});

describe("budgetDirection", () => {
  it("extrai a direção do ajuste de budget", () => {
    expect(budgetDirection("increase_budget")).toBe("increase");
    expect(budgetDirection("decrease_budget")).toBe("decrease");
    expect(budgetDirection("pause")).toBeNull();
  });
});
