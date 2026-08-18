/**
 * Cliente HTTP do OpenRouter (endpoint compatível OpenAI: POST /chat/completions).
 *
 * - Auth: header `Authorization: Bearer OPENROUTER_API_KEY`.
 * - `usage: { include: true }` p/ vir o **custo real** (essencial p/ metering/markup, §11).
 * - Suporta content multimodal (partes text + image_url).
 */

export interface OpenRouterClientOptions {
  readonly apiKey: string; // OPENROUTER_API_KEY
  readonly baseUrl?: string; // default https://openrouter.ai/api/v1
  /** headers de ranking do OpenRouter (opcionais). */
  readonly referer?: string; // HTTP-Referer
  readonly title?: string; // X-Title
}

/** Content part no formato do OpenRouter (compatível OpenAI). */
export type OpenRouterContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export interface OpenRouterMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | OpenRouterContentPart[];
}

export interface OpenRouterUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  /** custo real em USD (quando usage.include=true). */
  readonly cost?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

export interface OpenRouterChatRequest {
  readonly model: string;
  readonly messages: readonly OpenRouterMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly response_format?: Readonly<Record<string, unknown>>;
  readonly usage?: { readonly include: boolean };
}

export interface OpenRouterChatResponse {
  readonly choices: ReadonlyArray<{
    readonly message: { readonly content: string | null };
    readonly finish_reason: string;
  }>;
  readonly usage?: OpenRouterUsage;
}

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly referer: string | undefined;
  private readonly title: string | undefined;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.referer = options.referer;
    this.title = options.title;
  }

  /** POST /chat/completions com Authorization Bearer + headers de ranking. */
  chatCompletion(request: OpenRouterChatRequest): Promise<OpenRouterChatResponse> {
    // TODO: fetch com retry/backoff; mapear erros (429/5xx) p/ exceção tipada da casca.
    throw new Error("not implemented");
  }
}
