import { describe, expect, it } from "vitest";
import { enabledActionTypes } from "./enabled.js";

describe("enabledActionTypes", () => {
  it("mapeia só as tool-keys de escrita habilitadas p/ ActionType (identidade)", () => {
    const out = enabledActionTypes(new Set(["pause_entity", "adjust_budget"]));
    expect(out.sort()).toEqual(["adjust_budget", "pause_entity"]);
  });

  it("ignora tool-keys de criação (não são ActionType)", () => {
    const out = enabledActionTypes(new Set(["create_campaign", "duplicate_scale", "set_status"]));
    expect(out).toEqual(["set_status"]);
  });

  it("conjunto vazio → nenhuma ação (bloqueia tudo no guardrail)", () => {
    expect(enabledActionTypes(new Set())).toEqual([]);
  });
});
