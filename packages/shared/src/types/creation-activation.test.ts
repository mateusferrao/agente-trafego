import { describe, expect, it } from "vitest";
import { DEFAULT_CREATION_ACTIVATION, resolveCreationActivation } from "./index.js";

describe("resolveCreationActivation (v1 — nasce pausada × ativa)", () => {
  it("ausente → default 'paused' (conservador)", () => {
    expect(resolveCreationActivation(undefined)).toBe("paused");
    expect(resolveCreationActivation({})).toBe("paused");
    expect(DEFAULT_CREATION_ACTIVATION).toBe("paused");
  });

  it("'active' configurado → 'active' (nasce no ar, sem 2º OK)", () => {
    expect(resolveCreationActivation({ creationActivation: "active" })).toBe("active");
  });

  it("'paused' configurado → 'paused'", () => {
    expect(resolveCreationActivation({ creationActivation: "paused" })).toBe("paused");
  });
});
