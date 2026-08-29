import { DEFAULT_CREATIVE_SOURCE_STRATEGY } from "@trafego/shared";
import { describe, expect, it } from "vitest";
import { resolveCreativeSourceStrategy } from "./creative-source.js";

describe("resolveCreativeSourceStrategy", () => {
  it("ausente / malformado → default (serving.best_performing = hoje)", () => {
    expect(resolveCreativeSourceStrategy(undefined)).toEqual(DEFAULT_CREATIVE_SOURCE_STRATEGY);
    expect(resolveCreativeSourceStrategy({})).toEqual(DEFAULT_CREATIVE_SOURCE_STRATEGY);
    expect(resolveCreativeSourceStrategy({ creativeSource: { mode: "banana" } })).toEqual(DEFAULT_CREATIVE_SOURCE_STRATEGY);
  });

  it("serving sem servingPick → best_performing", () => {
    expect(resolveCreativeSourceStrategy({ creativeSource: { mode: "serving" } })).toEqual({ mode: "serving", servingPick: "best_performing" });
  });

  it("serving.agent preservado", () => {
    expect(resolveCreativeSourceStrategy({ creativeSource: { mode: "serving", servingPick: "agent" } })).toEqual({ mode: "serving", servingPick: "agent" });
  });

  it("library/both → sem servingPick", () => {
    expect(resolveCreativeSourceStrategy({ creativeSource: { mode: "library" } })).toEqual({ mode: "library" });
    expect(resolveCreativeSourceStrategy({ creativeSource: { mode: "both" } })).toEqual({ mode: "both" });
  });
});
