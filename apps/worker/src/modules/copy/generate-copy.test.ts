import { describe, expect, it } from "vitest";
import { LLMProviderError, type LLMProviderPort } from "@trafego/shared/ports";
import { generateCopy } from "./generate-copy.js";

function fakeLlm(output: unknown): Pick<LLMProviderPort, "completeStructured"> {
  return {
    completeStructured: async () => ({ output, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }) as never,
  };
}

function failingLlm(): Pick<LLMProviderPort, "completeStructured"> {
  return {
    completeStructured: async () => {
      throw new LLMProviderError("upstream", "boom");
    },
  };
}

const input = { model: "m", goal: "purchase" as const, variantsCount: 2 };

describe("generateCopy", () => {
  it("mapeia variações do LLM (limita ao variantsCount, normaliza CTA)", async () => {
    const out = await generateCopy(
      fakeLlm({
        variants: [
          { primaryText: " Texto 1 ", headline: " Título 1 ", description: "desc", cta: "shop_now" },
          { primaryText: "Texto 2", headline: "Título 2", description: null, cta: "cta_invalido" },
          { primaryText: "Texto 3", headline: "Título 3", description: null, cta: null },
        ],
      }),
      input,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ primaryText: "Texto 1", headline: "Título 1", description: "desc", cta: "shop_now" });
    expect(out[1]).toEqual({ primaryText: "Texto 2", headline: "Título 2" }); // CTA inválido dropado
  });

  it("cai no fallback determinístico quando o LLM falha", async () => {
    const out = await generateCopy(failingLlm(), {
      ...input,
      winnerCopy: [{ primaryText: "Campeão", headline: "Vencedor" }],
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.headline).toBe("Vencedor");
    expect(out[0]?.primaryText).toBe("Campeão");
  });

  it("fallback quando o LLM não retorna variações", async () => {
    const out = await generateCopy(fakeLlm({ variants: [] }), input);
    expect(out.length).toBeGreaterThan(0);
  });
});
