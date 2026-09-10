import { describe, expect, it, vi } from "vitest";
import { LLMProviderError } from "@trafego/shared/ports";
import { pickCreativeByReference, pickLibraryCreativeByContext } from "./match-library.js";

const CTX = { goal: "lead", businessContext: "clínica de estética", guidance: null };
const cands = [
  { assetId: "a", description: "antes/depois de harmonização" },
  { assetId: "b", description: "depoimento de paciente" },
  { assetId: "c", description: "oferta genérica" },
];

describe("pickLibraryCreativeByContext", () => {
  it("0 candidatos → null (sem chamar LLM)", async () => {
    const llm = { completeStructured: vi.fn() };
    expect(await pickLibraryCreativeByContext(llm as never, "m", CTX, [])).toBeNull();
    expect(llm.completeStructured).not.toHaveBeenCalled();
  });

  it("1 candidato → ele mesmo (sem LLM)", async () => {
    const llm = { completeStructured: vi.fn() };
    expect(await pickLibraryCreativeByContext(llm as never, "m", CTX, [cands[0]!])).toBe("a");
    expect(llm.completeStructured).not.toHaveBeenCalled();
  });

  const USAGE = { inputTokens: 0, outputTokens: 0 };

  it("≥2 → o índice escolhido pelo LLM (pelo contexto)", async () => {
    const llm = { completeStructured: vi.fn(async () => ({ output: { index: 1 }, usage: USAGE })) };
    expect(await pickLibraryCreativeByContext(llm as never, "m", CTX, cands)).toBe("b");
  });

  it("índice inválido → cai no 1º (recência)", async () => {
    const llm = { completeStructured: vi.fn(async () => ({ output: { index: 99 }, usage: USAGE })) };
    expect(await pickLibraryCreativeByContext(llm as never, "m", CTX, cands)).toBe("a");
  });

  it("erro do LLM → fallback no 1º (recência), não quebra", async () => {
    const llm = { completeStructured: vi.fn(async () => { throw new LLMProviderError("upstream", "falhou"); }) };
    expect(await pickLibraryCreativeByContext(llm as never, "m", CTX, cands)).toBe("a");
  });

  /** captura as `messages` enviadas ao LLM (typed p/ o mock não cair em tupla `[]`). */
  type CapturedRequest = { messages: Array<{ role: string; content: string }> };
  function mockLlm(index: number) {
    return { completeStructured: vi.fn(async (_req: CapturedRequest) => ({ output: { index }, usage: USAGE })) };
  }

  describe("sinais de qualidade do criativo (S4c — matcher VÊ proofStrength/persuasionSignals/weaknesses)", () => {
    it("candidato com sinais → aparecem na descrição enviada ao LLM (fit continua o critério, sinal é contexto extra)", async () => {
      const llm = mockLlm(0);
      const withSignals = [
        {
          assetId: "a",
          description: "antes/depois de harmonização",
          proofStrength: "strong" as const,
          persuasionSignals: 5,
          weaknesses: ["CTA fraco"],
        },
        { assetId: "b", description: "depoimento de paciente" },
      ];
      await pickLibraryCreativeByContext(llm as never, "m", CTX, withSignals);
      const sent = llm.completeStructured.mock.calls[0]![0].messages[1]!.content;
      expect(sent).toContain("antes/depois de harmonização");
      expect(sent).toContain("prova: strong");
      expect(sent).toContain("persuasão: 5/7");
      expect(sent).toContain("CTA fraco");
    });

    it("candidato sem sinais (undefined) → descrição não menciona prova/persuasão (não inventa placeholder)", async () => {
      const llm = mockLlm(0);
      await pickLibraryCreativeByContext(llm as never, "m", CTX, cands);
      const sent = llm.completeStructured.mock.calls[0]![0].messages[1]!.content;
      expect(sent).not.toContain("prova:");
      expect(sent).not.toContain("persuasão:");
    });

    it("instrução do sistema continua fit-first (não vira ranking por score)", async () => {
      const llm = mockLlm(0);
      await pickLibraryCreativeByContext(llm as never, "m", CTX, cands);
      const system = llm.completeStructured.mock.calls[0]![0].messages[0]!.content;
      expect(system).toMatch(/CASA|encaixa/i);
      expect(system).not.toMatch(/maior pontuação|maior score/i);
    });
  });

  describe("contexto enriquecido (S3 — estágio de público + tema do vencedor)", () => {
    it("estágio da campanha aparece no prompt (em linguagem de negócio, não a taxonomia crua)", async () => {
      const llm = mockLlm(0);
      await pickLibraryCreativeByContext(llm as never, "m", { ...CTX, campaignStage: "remarketing" }, cands);
      const sent = llm.completeStructured.mock.calls[0]![0].messages[1]!.content;
      expect(sent).toMatch(/Estágio do público:.*remarketing/);
      expect(sent).toMatch(/quente/);
    });

    it("estágio unknown → não injeta linha de estágio (não afirma o que não sabe)", async () => {
      const llm = mockLlm(0);
      await pickLibraryCreativeByContext(llm as never, "m", { ...CTX, campaignStage: "unknown" }, cands);
      const sent = llm.completeStructured.mock.calls[0]![0].messages[1]!.content;
      expect(sent).not.toContain("Estágio do público:");
    });

    it("tema/oferta do vencedor entra como referência (contexto de encaixe, não ordem de copiar)", async () => {
      const llm = mockLlm(0);
      await pickLibraryCreativeByContext(llm as never, "m", { ...CTX, winnerCopy: "50% off na primeira sessão" }, cands);
      const sent = llm.completeStructured.mock.calls[0]![0].messages[1]!.content;
      expect(sent).toContain("50% off na primeira sessão");
      expect(sent).toMatch(/refer[êe]ncia/i);
    });

    it("ângulo pedido pelo dono (S4) entra no prompt priorizando criativos que o comunicam", async () => {
      const llm = mockLlm(0);
      await pickLibraryCreativeByContext(llm as never, "m", { ...CTX, angle: "prova social" }, cands);
      const sent = llm.completeStructured.mock.calls[0]![0].messages[1]!.content;
      expect(sent).toMatch(/[ÂA]ngulo.*prova social/);
      expect(sent).toMatch(/priorize/i);
    });
  });
});

describe("pickCreativeByReference (Slice 3 — busca por descrição)", () => {
  const USAGE = { inputTokens: 0, outputTokens: 0 };
  it("0 candidatos → null (sem LLM)", async () => {
    const llm = { completeStructured: vi.fn() };
    expect(await pickCreativeByReference(llm as never, "m", "o vídeo da praia", [])).toBeNull();
    expect(llm.completeStructured).not.toHaveBeenCalled();
  });
  it("1 candidato → ele mesmo (sem LLM)", async () => {
    const llm = { completeStructured: vi.fn() };
    expect(await pickCreativeByReference(llm as never, "m", "x", [cands[0]!])).toBe("a");
  });
  it("casa a referência pela descrição (índice do LLM)", async () => {
    const llm = { completeStructured: vi.fn(async (_req: { messages: { content: string }[] }) => ({ output: { index: 1 }, usage: USAGE })) };
    expect(await pickCreativeByReference(llm as never, "m", "o depoimento", cands)).toBe("b");
    // a referência do usuário vai no prompt.
    const sent = llm.completeStructured.mock.calls[0]![0].messages[1]!.content;
    expect(sent).toContain("o depoimento");
  });
  it("nenhum casa (index -1) → null (não traz o errado)", async () => {
    const llm = { completeStructured: vi.fn(async () => ({ output: { index: -1 }, usage: USAGE })) };
    expect(await pickCreativeByReference(llm as never, "m", "algo que não existe", cands)).toBeNull();
  });
  it("erro do LLM → null (não chuta)", async () => {
    const llm = { completeStructured: vi.fn(async () => { throw new LLMProviderError("upstream", "x"); }) };
    expect(await pickCreativeByReference(llm as never, "m", "y", cands)).toBeNull();
  });
  it("passa o meta (orgId) adiante p/ o custo do LLM ser metrado", async () => {
    const llm = { completeStructured: vi.fn(async (_req: { meta?: { orgId?: string } }) => ({ output: { index: 0 }, usage: USAGE })) };
    await pickCreativeByReference(llm as never, "m", "x", cands, { orgId: "org-1", type: "message" });
    expect(llm.completeStructured.mock.calls[0]![0].meta).toEqual({ orgId: "org-1", type: "message" });
  });
});
