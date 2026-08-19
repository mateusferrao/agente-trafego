/**
 * Cliente HTTP do OpenRouter (endpoint compatível OpenAI: POST /chat/completions).
 *
 * - Auth: header `Authorization: Bearer OPENROUTER_API_KEY`.
 * - O `usage` (com **custo real** em USD) vem sempre na resposta — base do
 *   metering/markup (§11), sem parâmetro extra.
 * - Retry in-process com backoff+jitter em 429/5xx/rede/passthrough do provider.
 * - `fetch` é injetável (testes mockam; prod usa o global).
 */

import { LLMProviderError } from "@trafego/shared/ports";

export interface OpenRouterClientOptions {
  readonly apiKey: string; // OPENROUTER_API_KEY
  readonly baseUrl?: string; // default https://openrouter.ai/api/v1
  /** headers de ranking do OpenRouter (opcionais). */
  readonly referer?: string; // HTTP-Referer
  readonly title?: string; // X-Title
  /** nº de retentativas (default 3). */
  readonly maxRetries?: number;
  /** injeção p/ testes; default = fetch global. */
  readonly fetchFn?: typeof fetch;
  /** injeção p/ testes do backoff (evita esperar de verdade). */
  readonly sleepFn?: (ms: number) => Promise<void>;
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
  /** custo real em USD reportado pelo OpenRouter. */
  readonly cost?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

export interface OpenRouterChatRequest {
  readonly model: string;
  readonly messages: readonly OpenRouterMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly response_format?: Readonly<Record<string, unknown>>;
}

export interface OpenRouterChatResponse {
  readonly choices: ReadonlyArray<{
    readonly message: { readonly content: string | null };
    readonly finish_reason: string;
  }>;
  readonly usage?: OpenRouterUsage;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_RETRIES = 3;
// backoff base por tentativa (ms) — mesmo shape do padrão do automato-api.
const BACKOFF_MS = [500, 1500, 3000] as const;
const JITTER_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly referer: string | undefined;
  private readonly title: string | undefined;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/g, "");
    this.referer = options.referer;
    this.title = options.title;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? sleep;
  }

  /** POST /chat/completions com Authorization Bearer + retry/backoff. */
  async chatCompletion(request: OpenRouterChatRequest): Promise<OpenRouterChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;
    const body = JSON.stringify(request);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.attempt(url, headers, body);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof LLMProviderError &&
          (error.kind === "rate_limited" || error.kind === "upstream");
        if (!retryable || attempt === this.maxRetries) throw error;
        await this.sleepFn(backoffDelay(attempt));
      }
    }
    // inatingível (o loop sempre retorna ou lança), mas satisfaz o tipo.
    throw lastError instanceof Error ? lastError : new LLMProviderError("upstream", "falha desconhecida");
  }

  private async attempt(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<OpenRouterChatResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: "POST", headers, body });
    } catch (cause) {
      // erro de rede/DNS/conexão → transitório.
      throw new LLMProviderError("upstream", `falha de rede ao chamar o OpenRouter: ${String(cause)}`);
    }

    if (!res.ok) throw await mapHttpError(res);

    try {
      return (await res.json()) as OpenRouterChatResponse;
    } catch (cause) {
      throw new LLMProviderError("upstream", `resposta não-JSON do OpenRouter: ${String(cause)}`);
    }
  }
}

function backoffDelay(attempt: number): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  return base + Math.floor(Math.random() * JITTER_MS);
}

/** Traduz o status HTTP em `LLMProviderError` tipado (transitório × permanente). */
async function mapHttpError(res: Response): Promise<LLMProviderError> {
  const detail = await safeText(res);
  if (res.status === 429) return new LLMProviderError("rate_limited", `429 rate limited: ${detail}`);
  if (res.status >= 500) return new LLMProviderError("upstream", `${res.status} upstream: ${detail}`);
  // 400 "provider returned error" = passthrough transitório de upstream.
  if (res.status === 400 && /provider returned error/iu.test(detail)) {
    return new LLMProviderError("upstream", `400 provider passthrough: ${detail}`);
  }
  return new LLMProviderError("invalid_request", `${res.status}: ${detail}`);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<sem corpo>";
  }
}
