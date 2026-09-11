import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** Partes image_url da última chamada ao LLM (o que de fato foi pro provider). */
function imagePartsOf(spy: ReturnType<typeof vi.fn>): string[] {
  const messages = (spy.mock.calls[0]?.[0] as { messages: { role: string; content: unknown }[] }).messages;
  const user = messages.find((m) => m.role === "user");
  const parts = (user?.content ?? []) as { type: string; imageUrl?: string }[];
  return parts.filter((p) => p.type === "image_url").map((p) => p.imageUrl ?? "");
}

describe("createVisionResolver", () => {
  // Default: fetch de frame http devolve uma imagem válida (o baixa-e-inline do A2 depende disso).
  // Casos que testam a degradação sobrescrevem o stub.
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A2: baixa os frames http como data URL inline — o provider recebe bytes, nunca a URL crua do fbcdn", async () => {
    const { db } = fakeDb(false);
    const spy = vi.fn(async () => ({ output: RESULT, usage: {} }));
    const llm = { complete: vi.fn(), completeStructured: spy } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 1, logger });
    await resolver.resolve(input());
    const imgs = imagePartsOf(spy);
    expect(imgs).toHaveLength(2);
    expect(imgs.every((u) => u.startsWith("data:image/"))).toBe(true);
    expect(imgs.some((u) => u.startsWith("http"))).toBe(false);
  });

  it("A2: mistura http + data URL → baixa só o http e mantém o data (imagem de biblioteca)", async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const { db } = fakeDb(false);
    const llmSpy = vi.fn(async () => ({ output: RESULT, usage: {} }));
    const llm = { complete: vi.fn(), completeStructured: llmSpy } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 1, logger });
    await resolver.resolve({ ...input(), imageUrls: ["https://img/1.jpg", "data:image/png;base64,AAA"] });
    expect(fetchSpy).toHaveBeenCalledOnce(); // só o http
    const imgs = imagePartsOf(llmSpy);
    expect(imgs).toEqual([expect.stringMatching(/^data:image\/jpeg;base64,/), "data:image/png;base64,AAA"]);
  });

  it("A2: falha PARCIAL de download (1 de 2 frames) → analisa com o que veio, mas NÃO cacheia (transitório)", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/jpeg" } })
        : new Response(null, { status: 410 });
    }));
    const { db, inserts } = fakeDb(false);
    const llmSpy = vi.fn(async () => ({ output: RESULT, usage: {} }));
    const llm = { complete: vi.fn(), completeStructured: llmSpy } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 1, logger });
    const out = await resolver.resolve(input());
    expect(out).toMatchObject({ summary: "Bom criativo" });
    expect(llmSpy).toHaveBeenCalledOnce();
    expect(imagePartsOf(llmSpy)).toHaveLength(1); // só o frame que veio
    expect(inserts).toHaveLength(0); // parcial → não polui o cache permanente
  });

  it("A2: todos os frames mortos (download 410) → null, sem chamar o LLM", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410 })));
    const { db } = fakeDb(false);
    const llm = { complete: vi.fn(), completeStructured: vi.fn() } as unknown as LLMProviderPort;
    const resolver = createVisionResolver({ db: db as never, llm, model: "m", analyzerVersion: 1, logger });
    const out = await resolver.resolve(input());
    expect(out).toBeNull();
    expect(llm.completeStructured).not.toHaveBeenCalled();
  });

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
