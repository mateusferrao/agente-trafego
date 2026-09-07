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

function makeAdapter(fetchFn: typeof fetch, maxRetries = 3, structuredMaxRetries = 2) {
  const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep, maxRetries });
  return new OpenRouterAdapter({ client, structuredMaxRetries, sleepFn: noSleep });
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

  it("modelo que EXIGE reasoning (400) → retry SEM o param de reasoning (achado do E2E real)", async () => {
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      // 1ª chamada (com reasoning:{enabled:false}) → 400 mandatory; 2ª (sem reasoning) → 200.
      if (bodies.length === 1) {
        return jsonResponse({ error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled.", code: 400 } }, 400);
      }
      return jsonResponse(chatBody("revisão ok"));
    }) as unknown as typeof fetch;

    const res = await makeAdapter(fetchFn).complete({ model: "google/gemini-3.7-flash", messages: [{ role: "user", content: "oi" }], reasoning: { effort: "off" } });

    expect(res.output).toBe("revisão ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("reasoning"); // 1ª tentativa mandou o disable
    expect(bodies[1]).not.toContain("reasoning"); // retry removeu o param
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

  it("re-tenta quando o JSON é inválido e sucede na 2ª resposta", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatBody("não é json")))
      .mockResolvedValueOnce(jsonResponse(chatBody(JSON.stringify({ summary: "ok" })))) as unknown as typeof fetch;
    const res = await makeAdapter(fetchFn).completeStructured<{ summary: string }>({
      model: "m",
      messages: [],
      responseSchema: { type: "object" },
    });
    expect(res.output.summary).toBe("ok");
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it("primário produzindo JSON lixo (parse) → cai pro modelo RESERVA (achado do E2E real)", async () => {
    const models: string[] = [];
    // primário sempre lixo (structuredMaxRetries=2 → 3 tentativas), reserva devolve JSON válido.
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const m = (JSON.parse(String(init.body)) as { model: string }).model;
      models.push(m);
      if (m === "deepseek-flaky") return jsonResponse(chatBody('{"a":"a":"a":"a"'));
      return jsonResponse(chatBody(JSON.stringify({ summary: "reserva ok" })));
    }) as unknown as typeof fetch;
    const res = await makeAdapter(fetchFn).completeStructured<{ summary: string }>({
      model: "deepseek-flaky",
      fallbackModels: ["google-reliable"],
      messages: [],
      responseSchema: { type: "object" },
    });
    expect(res.output.summary).toBe("reserva ok");
    // primário 3x (esgota parse retries) + reserva 1x.
    expect(models.filter((m) => m === "deepseek-flaky").length).toBe(3);
    expect(models).toContain("google-reliable");
  });

  it("re-tenta quando o output falha a validação de schema (validate) e sucede depois", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatBody(JSON.stringify({ wrong: true }))))
      .mockResolvedValueOnce(jsonResponse(chatBody(JSON.stringify({ ok: true })))) as unknown as typeof fetch;
    const res = await makeAdapter(fetchFn).completeStructured<{ ok: boolean }>({
      model: "m",
      messages: [],
      responseSchema: { type: "object" },
      validate: (o) => (o as { ok?: boolean }).ok === true,
    });
    expect(res.output.ok).toBe(true);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it("esgota os retries de validação e lança parse_error", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(chatBody(JSON.stringify({ wrong: true }))),
    ) as unknown as typeof fetch;
    await expect(
      makeAdapter(fetchFn, 3, 2).completeStructured({
        model: "m",
        messages: [],
        responseSchema: { type: "object" },
        validate: () => false,
      }),
    ).rejects.toMatchObject({ kind: "parse_error" });
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });
});

describe("OpenRouterClient fallback chain", () => {
  it("primário esgota retries → tenta reserva (com retry) → sucede", async () => {
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.model === "primary") return jsonResponse({ error: "down" }, 503); // sempre 5xx
      return jsonResponse(chatBody("ok da reserva")); // reserva sucede
    }) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep, maxRetries: 2 });
    const res = await client.chatCompletion({
      model: "primary",
      messages: [{ role: "user", content: "oi" }],
      fallbackModels: ["reserve"],
    });
    expect(res.choices[0]!.message.content).toBe("ok da reserva");
    // primário: 1 + 2 retries = 3; reserva: 1 = 4
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(4);
  });

  it("erro permanente (401) → NÃO retenta nem tenta reserva", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep, maxRetries: 2 });
    await expect(
      client.chatCompletion({ model: "primary", messages: [], fallbackModels: ["reserve"] }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("todos os modelos esgotam → lança upstream", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "down" }, 500)) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep, maxRetries: 1 });
    await expect(
      client.chatCompletion({ model: "primary", messages: [], fallbackModels: ["reserve"] }),
    ).rejects.toMatchObject({ kind: "upstream" });
    // primário: 1+1=2; reserva: 1+1=2 → 4
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(4);
  });
});

describe("OpenRouterClient timeout", () => {
  it("passa AbortSignal quando requestTimeoutMs > 0", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(chatBody("ok"));
    }) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep, requestTimeoutMs: 5000 });
    await client.chatCompletion({ model: "m", messages: [{ role: "user", content: "oi" }] });
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("sem requestTimeoutMs NÃO passa signal (retrocompatível)", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeUndefined();
      return jsonResponse(chatBody("ok"));
    }) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep });
    await client.chatCompletion({ model: "m", messages: [{ role: "user", content: "oi" }] });
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

describe("OpenRouterClient.getGenerationCost", () => {
  it("retorna o total_cost quando o endpoint responde 200", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ data: { total_cost: 0.0012 } }));
    const client = new OpenRouterClient({ apiKey: "k", fetchFn: spy as unknown as typeof fetch, sleepFn: noSleep });

    const cost = await client.getGenerationCost("gen-123");

    expect(cost).toBeCloseTo(0.0012, 6);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/generation?id=gen-123");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("retorna undefined em resposta não-200, sem lançar", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "not found" }, 404)) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep });

    await expect(client.getGenerationCost("gen-123")).resolves.toBeUndefined();
  });

  it("retorna undefined quando o fetch rejeita (erro de rede), sem lançar", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep });

    await expect(client.getGenerationCost("gen-123")).resolves.toBeUndefined();
  });

  it("retorna undefined quando o corpo não tem data.total_cost numérico", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: { total_cost: "not-a-number" } })) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep });

    await expect(client.getGenerationCost("gen-123")).resolves.toBeUndefined();
  });

  it("não re-tenta em falha (canal best-effort, 1 tentativa só)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "boom" }, 503)) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchFn, sleepFn: noSleep });

    await client.getGenerationCost("gen-123");

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
