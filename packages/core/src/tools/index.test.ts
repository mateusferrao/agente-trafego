import { describe, expect, it } from "vitest";
import type { ToolBindingMode } from "@trafego/shared";
import { resolveEnabledTools } from "./index.js";

const b = (m: Record<string, ToolBindingMode>): ReadonlyMap<string, ToolBindingMode> => new Map(Object.entries(m));

describe("resolveEnabledTools", () => {
  it("sem binding: as 4 herdam allowedActions; criação = default-on", () => {
    const out = resolveEnabledTools(b({}), new Set(["pause_entity", "adjust_budget"]));
    // ações: só as do fallback
    expect(out.has("pause_entity")).toBe(true);
    expect(out.has("adjust_budget")).toBe(true);
    expect(out.has("resume_entity")).toBe(false);
    expect(out.has("set_status")).toBe(false);
    // criação: default-on mesmo sem binding
    expect(out.has("create_campaign")).toBe(true);
    expect(out.has("duplicate_scale")).toBe(true);
  });

  it("binding VENCE o fallback (disabled desliga; enabled liga)", () => {
    const out = resolveEnabledTools(
      b({ adjust_budget: "disabled", resume_entity: "enabled", create_campaign: "disabled" }),
      new Set(["pause_entity", "adjust_budget"]), // fallback ligava adjust_budget
    );
    expect(out.has("adjust_budget")).toBe(false); // binding disabled vence o fallback
    expect(out.has("resume_entity")).toBe(true); // binding enabled vence o fallback (que não tinha)
    expect(out.has("pause_entity")).toBe(true); // sem binding → fallback
    expect(out.has("create_campaign")).toBe(false); // criação desligada por binding
    expect(out.has("duplicate_scale")).toBe(true); // criação sem binding → default-on
  });

  it("mode shadow conta como habilitado", () => {
    const out = resolveEnabledTools(b({ set_status: "shadow" }), new Set([]));
    expect(out.has("set_status")).toBe(true);
  });

  it("fallback vazio + sem binding de criação → só criação (default-on), nenhuma mutação", () => {
    const out = resolveEnabledTools(b({}), new Set([]));
    expect([...out].sort()).toEqual(["create_campaign", "duplicate_scale"]);
  });
});
