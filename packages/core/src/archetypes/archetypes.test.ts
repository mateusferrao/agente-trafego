import { describe, expect, it } from "vitest";
import { ARCHETYPE_DEFAULTS, DEFAULT_ARCHETYPE_KEY, archetypeDefaults } from "./index.js";

describe("archetypeDefaults", () => {
  it("expõe o conservador como default", () => {
    expect(DEFAULT_ARCHETYPE_KEY).toBe("conservador");
    expect(ARCHETYPE_DEFAULTS.conservador).toBeDefined();
  });

  it("conservador nunca aplica sozinho (só sugere) — coerente com read-only", () => {
    const a = archetypeDefaults("conservador");
    expect(a.autonomyPolicy.bySource.playbook).toBe("suggest");
    expect(a.autonomyPolicy.bySource.llm).toBe("suggest");
  });

  it("cai no conservador p/ chave desconhecida", () => {
    expect(archetypeDefaults("inexistente").key).toBe("conservador");
    expect(archetypeDefaults().key).toBe("conservador");
  });

  it("traz systemPrompt e goals vazio p/ zero-config", () => {
    const a = archetypeDefaults();
    expect(a.systemPrompt.length).toBeGreaterThan(0);
    expect(a.goals).toEqual({});
  });
});
