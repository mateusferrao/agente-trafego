import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { LLMProviderPort } from "@trafego/shared/ports";
import { LLMProviderError } from "@trafego/shared/ports";
import { createVisionResolver, creativeContentHash } from "./resolver.js";

const RESULT = { summary: "Bom criativo", hook: "Promessa clara", strengths: ["cor"], weaknesses: ["texto"], score: 8 };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

/** DB fake com fila de resultados de SELECT + captura dos INSERTs. */
function fakeDb(cacheHit: boolean) {
  const inserts: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (cacheHit ? [{ result: RESULT }] : []),
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (v: unknown) => ({ onConflictDoNothing: async () => { inserts.push(v); } }),
    })),
  };
  return { db, inserts };
}

function input() {
  return {
    creativeId: "cr-1",
    imageUrls: ["https://img/1.jpg", "https://img/2.jpg"],
    contentHash: creativeContentHash("cr-1:V1", "copy"),
    copy: "copy",
  };
}

describe("createVisionResolver", () => {
  it("cache hit: retorna do cache sem chamar o LLM", async () => {
    const { db } = fakeDb(true);
    const llm = { complete: vi.fn(), completeStructured: vi.fn() } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 1, logger });
    const out = await resolver.resolve(input());
    expect(out).toEqual(RESULT);
    expect(llm.completeStructured).not.toHaveBeenCalled();
  });

  it("cache miss: chama o LLM multimodal e grava no cache", async () => {
    const { db, inserts } = fakeDb(false);
    const llm = { complete: vi.fn(), completeStructured: vi.fn(async () => ({ output: RESULT, usage: { inputTokens: 1, outputTokens: 1 } })) } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 1, logger });
    const out = await resolver.resolve(input());
    expect(out).toMatchObject({ summary: "Bom criativo", hook: "Promessa clara", score: 8 });
    expect(llm.completeStructured).toHaveBeenCalledOnce();
    expect(inserts).toHaveLength(1);
  });

  it("mapeia body + proofStrength; descarta proofStrength inválido", async () => {
    const raw = { ...RESULT, body: "antes e depois + autoridade no assunto", proofStrength: "strong" };
    const { db } = fakeDb(false);
    const llm = { complete: vi.fn(), completeStructured: vi.fn(async () => ({ output: raw, usage: {} })) } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 3, logger });
    const out = await resolver.resolve(input());
    expect(out).toMatchObject({ body: "antes e depois + autoridade no assunto", proofStrength: "strong" });

    const { db: db2 } = fakeDb(false);
    const llm2 = { complete: vi.fn(), completeStructured: vi.fn(async () => ({ output: { ...RESULT, proofStrength: "gigante" }, usage: {} })) } as unknown as LLMProviderPort;
    const resolver2 = createVisionResolver({ db: db2 as never, llm: llm2, model: "m", analyzerVersion: 3, logger });
    const out2 = await resolver2.resolve(input());
    expect(out2!.proofStrength).toBeUndefined();
  });

  it("S4b: mapeia persuasionSignals (densidade de gatilhos de Cialdini)", async () => {
    const raw = { ...RESULT, proofStrength: "weak", persuasionSignals: 2 };
    const { db } = fakeDb(false);
    const llm = { complete: vi.fn(), completeStructured: vi.fn(async () => ({ output: raw, usage: {} })) } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 4, logger });
    const out = await resolver.resolve(input());
    expect(out).toMatchObject({ proofStrength: "weak", persuasionSignals: 2 });
  });

  it("erro do LLM (borda) degrada a null (não quebra a análise)", async () => {
    const { db } = fakeDb(false);
    const llm = {
      complete: vi.fn(),
      completeStructured: vi.fn(async () => { throw new LLMProviderError("upstream", "timeout"); }),
    } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 1, logger });
    const out = await resolver.resolve(input());
    expect(out).toBeNull();
  });
});
