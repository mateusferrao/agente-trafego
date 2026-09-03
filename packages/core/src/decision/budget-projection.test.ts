import { describe, expect, it } from "vitest";
import {
  ACTION_PARAM_AMOUNT_MINOR,
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  BUDGET_MODE_DECREASE,
  BUDGET_MODE_INCREASE,
  BUDGET_MODE_SET,
} from "@trafego/shared";
import { projectBudgetTargetMinor } from "./index.js";

describe("projectBudgetTargetMinor (projeção do orçamento resultante p/ exibição)", () => {
  it("increase +20% sobre o atual", () => {
    expect(
      projectBudgetTargetMinor(12000, { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: 20 }),
    ).toBe(14400);
  });

  it("decrease -20% sobre o atual", () => {
    expect(
      projectBudgetTargetMinor(12000, { [ACTION_PARAM_MODE]: BUDGET_MODE_DECREASE, [ACTION_PARAM_PCT]: 20 }),
    ).toBe(9600);
  });

  it("set → o valor absoluto pedido (independe do atual)", () => {
    expect(
      projectBudgetTargetMinor(12000, { [ACTION_PARAM_MODE]: BUDGET_MODE_SET, [ACTION_PARAM_AMOUNT_MINOR]: 15000 }),
    ).toBe(15000);
    expect(
      projectBudgetTargetMinor(null, { [ACTION_PARAM_MODE]: BUDGET_MODE_SET, [ACTION_PARAM_AMOUNT_MINOR]: 15000 }),
    ).toBe(15000);
  });

  it("pct sem atual conhecido → null (não dá pra projetar)", () => {
    expect(projectBudgetTargetMinor(null, { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: 20 })).toBeNull();
    expect(projectBudgetTargetMinor(0, { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: 20 })).toBeNull();
  });

  it("params inválidos (sem pct/valor, modo desconhecido) → null", () => {
    expect(projectBudgetTargetMinor(12000, {})).toBeNull();
    expect(projectBudgetTargetMinor(12000, { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE })).toBeNull();
    expect(projectBudgetTargetMinor(12000, { [ACTION_PARAM_MODE]: BUDGET_MODE_SET })).toBeNull();
  });

  it("arredonda pro centavo mais próximo", () => {
    expect(
      projectBudgetTargetMinor(10000, { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: 15 }),
    ).toBe(11500);
    // 3333 * 1.1 = 3666.3 → 3666
    expect(
      projectBudgetTargetMinor(3333, { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: 10 }),
    ).toBe(3666);
  });
});
