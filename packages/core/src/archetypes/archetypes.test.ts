import { describe, expect, it } from "vitest";
import {
  ARCHETYPE_DEFAULTS,
  DEFAULT_ARCHETYPE_KEY,
  archetypeDefaults,
  composeAgentPrompt,
} from "./index.js";

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

describe("composeAgentPrompt", () => {
  const base = "PROMPT BASE";

  it("sem extras → devolve a base intacta", () => {
    expect(composeAgentPrompt(base)).toBe(base);
    expect(composeAgentPrompt(base, {})).toBe(base);
  });

  it("anexa contexto do negócio como bloco rotulado, preservando a base", () => {
    const out = composeAgentPrompt(base, { businessContext: "Lançamento até 30/08; público médico." });
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain("Contexto do negócio");
    expect(out).toContain("público médico");
  });

  it("anexa orientações como bloco rotulado", () => {
    const out = composeAgentPrompt(base, { guidance: "Não sugira pausar nos 3 primeiros dias." });
    expect(out).toContain("Orientações do dono");
    expect(out).toContain("3 primeiros dias");
  });

  it("ordem estável: base → contexto → orientações", () => {
    const out = composeAgentPrompt(base, { guidance: "GUIA", businessContext: "CTX" });
    expect(out.indexOf(base)).toBeLessThan(out.indexOf("CTX"));
    expect(out.indexOf("CTX")).toBeLessThan(out.indexOf("GUIA"));
  });

  it("ignora texto só-espaços (tratado como ausente)", () => {
    expect(composeAgentPrompt(base, { businessContext: "   ", guidance: "\n\t" })).toBe(base);
  });
});
