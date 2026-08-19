import type {
  LLMCompletion,
  LLMProviderPort,
  LLMRequest,
  MeteringPort,
} from "@trafego/shared/ports";
import type { OrgId, RunId } from "@trafego/shared/types";

export interface LlmMeteringOptions {
  readonly metering: MeteringPort;
  /** nome do provider p/ o usage_event (ex: "openrouter"). */
  readonly provider: string;
  /** log opcional de falha de metering (best-effort, não quebra a chamada). */
  readonly onError?: (err: unknown) => void;
}

/**
 * Decorator cross-cutting (§13): envolve um `LLMProviderPort` e emite 1
 * `usage_event` por chamada, atribuído via `request.meta` (orgId/runId/type) —
 * sem estado mutável compartilhado entre runs concorrentes. Metering é
 * best-effort: falha ao gravar NUNCA quebra a análise (fail-open). Sem
 * `meta.orgId`, não há a quem atribuir → não grava.
 */
export function withLlmMetering(inner: LLMProviderPort, opts: LlmMeteringOptions): LLMProviderPort {
  async function meter(request: LLMRequest, usage: LLMCompletion<unknown>["usage"]): Promise<void> {
    const orgId = request.meta?.orgId;
    if (!orgId) return;
    try {
      await opts.metering.record({
        orgId: orgId as OrgId,
        ...(request.meta?.runId ? { runId: request.meta.runId as RunId } : {}),
        type: request.meta?.type ?? "llm",
        payload: {},
        provider: opts.provider,
        model: request.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      });
    } catch (err) {
      opts.onError?.(err);
    }
  }

  return {
    async complete(request: LLMRequest): Promise<LLMCompletion<string>> {
      const completion = await inner.complete(request);
      await meter(request, completion.usage);
      return completion;
    },
    async completeStructured<T>(request: LLMRequest): Promise<LLMCompletion<T>> {
      const completion = await inner.completeStructured<T>(request);
      await meter(request, completion.usage);
      return completion;
    },
  };
}
