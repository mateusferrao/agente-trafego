import { describe, expect, it, vi } from "vitest";
import type { LLMProviderPort, MeteringPort } from "@trafego/shared/ports";
import { withLlmMetering } from "./llm-metering.decorator.js";

const USAGE = { inputTokens: 100, outputTokens: 20, costUsd: 0.001 };

function fakeInner(): LLMProviderPort {
  return {
    complete: vi.fn(async () => ({ output: "ok", usage: USAGE })),
    completeStructured: vi.fn(async () => ({ output: { a: 1 }, usage: USAGE })),
  } as unknown as LLMProviderPort;
}

function fakeMetering(): MeteringPort & { records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    record: vi.fn(async (e) => { records.push(e); }),
    summarize: vi.fn(async () => ({ orgId: "o" as never, period: "2026-08", totalCostUsd: 0, byType: {} })),
    llmCostInPeriod: vi.fn(async () => 0),
  };
}

describe("withLlmMetering", () => {
  it("emite 1 usage_event por chamada, atribuído por meta (org/run/type)", async () => {
    const metering = fakeMetering();
    const llm = withLlmMetering(fakeInner(), { metering, provider: "openrouter" });
    await llm.completeStructured({
      model: "m",
      messages: [],
      meta: { orgId: "org-1", runId: "run-1", type: "unit" },
    });
    expect(metering.records).toHaveLength(1);
    expect(metering.records[0]).toMatchObject({
      orgId: "org-1",
      runId: "run-1",
      type: "unit",
      provider: "openrouter",
      model: "m",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    });
  });

  it("sem meta.orgId não grava (não há a quem atribuir)", async () => {
    const metering = fakeMetering();
    const llm = withLlmMetering(fakeInner(), { metering, provider: "openrouter" });
    await llm.complete({ model: "m", messages: [] });
    expect(metering.records).toHaveLength(0);
  });

  it("falha ao gravar metering NÃO quebra a chamada (fail-open) + chama onError", async () => {
    const onError = vi.fn();
    const metering = fakeMetering();
    metering.record = vi.fn(async () => { throw new Error("db down"); });
    const llm = withLlmMetering(fakeInner(), { metering, provider: "openrouter", onError });
    const out = await llm.complete({ model: "m", messages: [], meta: { orgId: "org-1" } });
    expect(out.output).toBe("ok");
    expect(onError).toHaveBeenCalledOnce();
  });
});
