import { describe, expect, it, vi } from "vitest";
import { LLMProviderError } from "@trafego/shared/ports";
import { OpenRouterAdapter } from "./openrouter.adapter.js";
import { OpenRouterClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chatBody(content: string, usage?: Record<string, unknown>) {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  };
}

const noSleep = () => Promise.resolve();

function makeAdapter(fetchFn: typeof fetch, maxRetries = 3) {
  const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep, maxRetries });
  return new OpenRouterAdapter({ client });
}

describe("OpenRouterAdapter.complete", () => {
  it("retorna texto + usage com custo real", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(chatBody("resumo da conta", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0012 })),
    ) as unknown as typeof fetch;
    const adapter = makeAdapter(fetchFn);

    const res = await adapter.complete({ model: "m", messages: [{ role: "user", content: "oi" }] });

    expect(res.output).toBe("resumo da conta");
    expect(res.usage.inputTokens).toBe(100);
    expect(res.usage.outputTokens).toBe(20);
    expect(res.usage.costUsd).toBeCloseTo(0.0012, 6);
  });

  it("custo ausente ≠ zero: omite costUsd quando o provider não reporta", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(chatBody("x", { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })),
    ) as unknown as typeof fetch;
    const res = await makeAdapter(fetchFn).complete({ model: "m", messages: [{ role: "user", content: "oi" }] });
    expect(res.usage.costUsd).toBeUndefined();
  });
});

describe("OpenRouterAdapter.completeStructured", () => {
  it("envia response_format json_schema e parseia o objeto", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.response_format.type).toBe("json_schema");
      expect(body.response_format.json_schema.strict).toBe(true);
      // opt-in explícito no accounting de custo (§11) — garante `usage.cost` mesmo
      // em gateway compatível que ainda exija o flag.
      expect(body.usage).toEqual({ include: true });
      return jsonResponse(chatBody(JSON.stringify({ summary: "ok", findings: [], recommendations: [] })));
    }) as unknown as typeof fetch;

    const adapter = makeAdapter(fetchFn);
    const res = await adapter.completeStructured<{ summary: string }>({
      model: "m",
      messages: [{ role: "user", content: "analisa" }],
      responseSchema: { type: "object" },
      responseSchemaName: "account_analysis",
    });
    expect(res.output.summary).toBe("ok");
  });

  it("extrai o JSON mesmo cercado por texto/markdown", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(chatBody('Aqui está:\n```json\n{"summary":"ok","findings":[],"recommendations":[]}\n```')),
    ) as unknown as typeof fetch;
    const res = await makeAdapter(fetchFn).completeStructured<{ summary: string }>({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      responseSchema: { type: "object" },
    });
    expect(res.output.summary).toBe("ok");
  });

  it("lança parse_error quando o output não é JSON", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(chatBody("desculpe, não consegui"))) as unknown as typeof fetch;
    await expect(
      makeAdapter(fetchFn).completeStructured({ model: "m", messages: [], responseSchema: { type: "object" } }),
    ).rejects.toMatchObject({ kind: "parse_error" });
  });
});

describe("OpenRouterClient retry", () => {
  it("re-tenta em 429 e sucede depois", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "rate" }, 429);
      return jsonResponse(chatBody("ok"));
    }) as unknown as typeof fetch;

    const res = await makeAdapter(fetchFn).complete({ model: "m", messages: [] });
    expect(res.output).toBe("ok");
    expect(calls).toBe(2);
  });

  it("NÃO re-tenta em 400 e propaga invalid_request", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return jsonResponse({ error: "bad" }, 400);
    }) as unknown as typeof fetch;

    await expect(makeAdapter(fetchFn).complete({ model: "m", messages: [] })).rejects.toBeInstanceOf(LLMProviderError);
    expect(calls).toBe(1);
  });

  it("esgota as retentativas em 5xx e lança upstream", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "boom" }, 503)) as unknown as typeof fetch;
    await expect(
      makeAdapter(fetchFn, 2).complete({ model: "m", messages: [] }),
    ).rejects.toMatchObject({ kind: "upstream" });
    expect(fetchFn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });
});
