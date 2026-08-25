import { describe, expect, it } from "vitest";
import type { ActionType, RecommendationActionType } from "@trafego/shared";
import { RECOMMENDATION_KINDS } from "@trafego/shared";
import {
  applicableActionType,
  budgetDirection,
  kindForRecommendation,
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

describe("kindForRecommendation", () => {
  it("classifica ações executáveis como platform_action", () => {
    expect(kindForRecommendation("pause")).toBe("platform_action");
    expect(kindForRecommendation("resume")).toBe("platform_action");
    expect(kindForRecommendation("increase_budget")).toBe("platform_action");
    expect(kindForRecommendation("decrease_budget")).toBe("platform_action");
  });

  it("classifica revisões/investigação como direção humana", () => {
    expect(kindForRecommendation("review_creative")).toBe("human_direction");
    expect(kindForRecommendation("review_audience")).toBe("human_direction");
    expect(kindForRecommendation("investigate")).toBe("human_direction");
  });

  it("classifica 'manter' como insight (leitura, sem ação)", () => {
    expect(kindForRecommendation("keep")).toBe("insight");
  });

  it("cobre TODOS os RecommendationActionType e sempre devolve um kind válido", () => {
    const all: RecommendationActionType[] = [
      "pause",
      "resume",
      "increase_budget",
      "decrease_budget",
      "review_creative",
      "review_audience",
      "investigate",
      "keep",
    ];
    for (const t of all) {
      expect(RECOMMENDATION_KINDS).toContain(kindForRecommendation(t));
    }
  });

  it("é coerente com applicableActionType: platform_action ⟺ ação tipada existe", () => {
    const all: RecommendationActionType[] = [
      "pause",
      "resume",
      "increase_budget",
      "decrease_budget",
      "review_creative",
      "review_audience",
      "investigate",
      "keep",
    ];
    for (const t of all) {
      const isPlatform = kindForRecommendation(t) === "platform_action";
      expect(isPlatform).toBe(applicableActionType(t) !== null);
    }
  });
});
