export type LLMTextPart = { readonly type: "text"; readonly text: string };
export type LLMImagePart = { readonly type: "image_url"; readonly imageUrl: string };
export type LLMContentPart = LLMTextPart | LLMImagePart;

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | readonly LLMContentPart[];
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
  /** custo real reportado pelo provider (OpenRouter). */
  readonly costUsd: number;
}

export interface LLMRequest {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  /** structured output: JSON Schema esperado. */
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface LLMCompletion<T = string> {
  readonly output: T;
  readonly usage: LLMUsage;
}

/**
 * Borda de LLM. Adapter MVP = OpenRouter (1 gateway multimodal).
 * Retorna sempre `usage` com custo real → base do metering/markup.
 */
export interface LLMProviderPort {
  complete(request: LLMRequest): Promise<LLMCompletion<string>>;
  completeStructured<T>(request: LLMRequest): Promise<LLMCompletion<T>>;
}
