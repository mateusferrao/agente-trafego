import { describe, expect, it } from "vitest";
import type { EntityObjective } from "@trafego/shared";
import { resolveConversion } from "./index.js";

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
