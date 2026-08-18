import type {
  LLMCompletion,
  LLMContentPart,
  LLMMessage,
  LLMProviderPort,
  LLMRequest,
  LLMUsage,
} from "@trafego/shared/ports";
import {
  OpenRouterClient,
  type OpenRouterContentPart,
  type OpenRouterMessage,
  type OpenRouterUsage,
} from "./client.js";

export interface OpenRouterAdapterDeps {
  readonly client: OpenRouterClient;
}

/**
 * Adapter OpenRouter da `LLMProviderPort` (§5/§11).
 * 1 gateway multimodal; retorna sempre `usage` com **custo real** do provider
 * (base do metering/markup). Suporta image parts (visão de criativo).
 */
export class OpenRouterAdapter implements LLMProviderPort {
  private readonly client: OpenRouterClient;

  constructor(deps: OpenRouterAdapterDeps) {
    this.client = deps.client;
  }

  async complete(request: LLMRequest): Promise<LLMCompletion<string>> {
    // TODO: mapMessages → chatCompletion(usage.include=true) → { output: text, usage }.
    throw new Error("not implemented");
  }

  async completeStructured<T>(request: LLMRequest): Promise<LLMCompletion<T>> {
    // TODO: injetar response_format(json_schema=request.responseSchema) → parse<T> do content.
    throw new Error("not implemented");
  }

  /** Converte LLMMessage[] (domínio) → mensagens OpenRouter (com image parts). */
  mapMessages(messages: readonly LLMMessage[]): OpenRouterMessage[] {
    // TODO: string → content string; parts → text/image_url (mapPart).
    throw new Error("not implemented");
  }

  /** Mapeia uma parte de conteúdo do domínio p/ o formato OpenRouter. */
  mapPart(part: LLMContentPart): OpenRouterContentPart {
    // TODO: text → {type:'text'}; image_url → {type:'image_url', image_url:{url}}.
    throw new Error("not implemented");
  }

  /** Extrai `usage` com custo real reportado pelo OpenRouter. */
  mapUsage(usage: OpenRouterUsage | undefined): LLMUsage {
    // TODO: prompt_tokens→inputTokens, completion_tokens→outputTokens, cost→costUsd (default 0).
    throw new Error("not implemented");
  }
}
