import { describe, expect, it } from "vitest";
import { addDays, resolveWindows } from "./window.js";

describe("addDays", () => {
  it("soma/subtrai dias atravessando meses", () => {
    expect(addDays("2026-08-18", -6)).toBe("2026-08-12");
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
  });
});

describe("resolveWindows", () => {
  it("janela = últimos N dias; baseline = os N anteriores", () => {
    const { window, baseline } = resolveWindows("2026-08-18", 7, 7);
    expect(window).toEqual({ since: "2026-08-12", until: "2026-08-18" });
    expect(baseline).toEqual({ since: "2026-08-05", until: "2026-08-11" });
  });
});
