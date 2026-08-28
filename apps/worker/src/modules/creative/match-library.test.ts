import { describe, expect, it, vi } from "vitest";
import { LLMProviderError } from "@trafego/shared/ports";
import { pickLibraryCreativeByContext } from "./match-library.js";

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
});
