import { describe, expect, it } from "vitest";
import { riskForAction } from "./index.js";

describe("riskForAction", () => {
  it("pausar = low (parar gasto, reversível)", () => {
    expect(riskForAction("pause_entity")).toBe("low");
  });

  it("religar = medium (volta a gastar)", () => {
    expect(riskForAction("resume_entity")).toBe("medium");
  });

  it("set_status = medium", () => {
    expect(riskForAction("set_status")).toBe("medium");
  });

  it("cortar budget (decrease) = low — auto-aplicável no act_safe", () => {
    expect(riskForAction("adjust_budget", { mode: "decrease", pct: 20 })).toBe("low");
  });

  it("aumentar budget (increase) = medium — precisa de OK no act_safe", () => {
    expect(riskForAction("adjust_budget", { mode: "increase", pct: 20 })).toBe("medium");
  });

  it("adjust_budget sem direção → medium (conservador)", () => {
    expect(riskForAction("adjust_budget")).toBe("medium");
  });
});
