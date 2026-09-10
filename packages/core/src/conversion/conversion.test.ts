import { describe, expect, it } from "vitest";
import type { EntityObjective } from "@trafego/shared";
import { cpaLabelFor, isMessagingGoal, resolveConversion } from "./index.js";

describe("isMessagingGoal (destino WhatsApp vs site)", () => {
  it("só messaging_started é destino de WhatsApp; os demais são site/lead/app", () => {
    expect(isMessagingGoal("messaging_started")).toBe(true);
    expect(isMessagingGoal("purchase")).toBe(false);
    expect(isMessagingGoal("lead")).toBe(false);
    expect(isMessagingGoal("app_install")).toBe(false);
    expect(isMessagingGoal(null)).toBe(false);
    expect(isMessagingGoal(undefined)).toBe(false);
  });
});

describe("resolveConversion", () => {
  it("sem objetivo e sem override → null (sem conversão; julgar por CPC/CPM)", () => {
    expect(resolveConversion(undefined)).toBeNull();
  });

  it("usa o objetivo próprio da entidade (o que o usuário definiu na Meta)", () => {
    const objective: EntityObjective = { goal: "purchase" };
    expect(resolveConversion(objective)).toEqual({ goal: "purchase" });
  });

  it("conversão personalizada preserva o id (p/ casar no breakdown)", () => {
    const objective: EntityObjective = {
      goal: "custom",
      customConversionId: "170673",
      label: "Compra do curso",
    };
    expect(resolveConversion(objective)).toEqual({
      goal: "custom",
      customConversionId: "170673",
    });
  });

  it("override do agente vence o objetivo próprio (personalização)", () => {
    const objective: EntityObjective = { goal: "purchase" };
    expect(resolveConversion(objective, { goal: "lead" })).toEqual({ goal: "lead" });
  });
});

describe("cpaLabelFor", () => {
  it("deriva o rótulo do conversionGoal (venda/lead)", () => {
    expect(cpaLabelFor("purchase")).toBe("Custo por venda");
    expect(cpaLabelFor("lead")).toBe("Custo por lead");
    expect(cpaLabelFor("messaging_started")).toBe("Custo por conversa");
  });
  it("sem goal → genérico 'Custo por resultado' (corrige o hardcoded)", () => {
    expect(cpaLabelFor(null)).toBe("Custo por resultado");
    expect(cpaLabelFor(undefined)).toBe("Custo por resultado");
  });
});
