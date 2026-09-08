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

  // aterramento (Slice 2): a copy conversa com o criativo + fala pro público + usa método de persuasão.
  function capturingLlm(): { llm: Pick<LLMProviderPort, "completeStructured">; msgs: () => { role: string; content: string }[] } {
    let captured: { role: string; content: string }[] = [];
    return {
      llm: {
        completeStructured: async (req: { messages: { role: string; content: string }[] }) => {
          captured = req.messages;
          return { output: { variants: [{ primaryText: "t", headline: "h", description: null, cta: null }] }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } } as never;
        },
      },
      msgs: () => captured,
    };
  }

  it("system prompt SEMPRE carrega o método (gancho/prova/CTA + gatilhos de persuasão)", async () => {
    const cap = capturingLlm();
    await generateCopy(cap.llm, input);
    const sys = cap.msgs().find((m) => m.role === "system")!.content;
    expect(sys).toContain("gancho");
    expect(sys.toLowerCase()).toContain("prova");
    expect(sys.toLowerCase()).toContain("persuasão");
  });

  it("aterra no CRIATIVO líder e no PÚBLICO quando presentes", async () => {
    const cap = capturingLlm();
    await generateCopy(cap.llm, { ...input, creativeDescription: "gancho de antes/depois, prova forte", audience: "Belo Horizonte, 45+ anos, mulheres" });
    const user = cap.msgs().find((m) => m.role === "user")!.content;
    expect(user).toContain("gancho de antes/depois");
    expect(user).toContain("Belo Horizonte, 45+ anos, mulheres");
    expect(user.toLowerCase()).toContain("criativo que acompanha");
  });

  it("degrada sem criativo/público (não injeta blocos vazios)", async () => {
    const cap = capturingLlm();
    await generateCopy(cap.llm, input);
    const user = cap.msgs().find((m) => m.role === "user")!.content;
    expect(user.toLowerCase()).not.toContain("criativo que acompanha");
    expect(user.toLowerCase()).not.toContain("para quem");
  });
});
