import { describe, expect, it } from "vitest";
import { enabledActionTypes } from "./tools.js";

describe("enabledActionTypes", () => {
  it("mapeia só as tool-keys de AÇÃO habilitadas p/ ActionType", () => {
    expect(enabledActionTypes(new Set(["pause_entity"]))).toEqual(["pause_entity"]);
  });
  it("ignora tool-keys de criação (não são ActionType)", () => {
    const out = enabledActionTypes(new Set(["pause_entity", "create_campaign", "duplicate_scale"]));
    expect(out).toEqual(["pause_entity"]);
  });
  it("preserva a ordem das WRITE_ACTION_TOOL_KEYS e cobre as 5", () => {
    const out = enabledActionTypes(new Set(["adjust_budget", "pause_entity", "adjust_audience", "resume_entity", "set_status"]));
    expect(out).toEqual(["pause_entity", "resume_entity", "set_status", "adjust_budget", "adjust_audience"]);
  });
  it("Set vazio → []", () => {
    expect(enabledActionTypes(new Set())).toEqual([]);
  });
});
