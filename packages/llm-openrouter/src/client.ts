/**
 * Cliente HTTP do OpenRouter (endpoint compatível OpenAI: POST /chat/completions).
 *
 * - Auth: header `Authorization: Bearer OPENROUTER_API_KEY`.
 * - O `usage` (com **custo real** em USD) é a base do metering/markup (§11). Hoje
 *   o OpenRouter já o inclui por padrão (`usage.include` virou no-op), mas mandamos
 *   `usage: { include: true }` mesmo assim (belt-and-suspenders) — `OPENROUTER_BASE_URL`
 *   é configurável e um gateway compatível mais antigo ainda pode exigir o flag.
 * - Retry in-process com backoff+jitter em 429/5xx/rede/passthrough do provider.
 * - `fetch` é injetável (testes mockam; prod usa o global).
 */

import { sleep } from "@trafego/shared";
import { LLMProviderError } from "@trafego/shared/ports";

export interface OpenRouterClientOptions {
  readonly apiKey: string; // OPENROUTER_API_KEY
  readonly baseUrl?: string; // default https://openrouter.ai/api/v1
  /** headers de ranking do OpenRouter (opcionais). */
  readonly referer?: string; // HTTP-Referer
  readonly title?: string; // X-Title
  /** nº de retentativas (default 3). */
  readonly maxRetries?: number;
  /** timeout por tentativa HTTP (ms). 0/undefined = sem timeout. Evita hang infinito. */
  readonly requestTimeoutMs?: number;
  /** logger opcional p/ observar retries/fallback (pontos de falha). */
  readonly logger?: ClientLogger;
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
  /** Controle de reasoning do OpenRouter (`{ effort | max_tokens | exclude | enabled }`). */
  readonly reasoning?: Readonly<Record<string, unknown>>;
  /**
   * Modelos de RESERVA (NÃO vai no corpo). Cadeia de fallback DO NOSSO lado: cada modelo
   * roda o retry/backoff completo; se esgotar, tenta o próximo (também com retry/backoff).
   * Diferente do `models` do OpenRouter (fallback de 1 tentativa) — aqui é retry por modelo.
   */
  readonly fallbackModels?: readonly string[];
}

/** Logger estrutural (pino-compatível) — injetável p/ ver retries/fallback sem acoplar pino. */
export interface ClientLogger {
  warn(obj: unknown, msg: string): void;
  info?(obj: unknown, msg: string): void;
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
const GENERATION_LOOKUP_TIMEOUT_MS = 3_000;
// backoff base por tentativa (ms) — mesmo shape do padrão do automato-api.
const BACKOFF_MS = [500, 1500, 3000] as const;
const JITTER_MS = 250;

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly referer: string | undefined;
  private readonly title: string | undefined;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: ClientLogger | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/g, "");
    this.referer = options.referer;
    this.title = options.title;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? sleep;
  }

  /**
   * POST /chat/completions com Authorization Bearer. Cadeia de modelos: o primário roda o
   * retry/backoff COMPLETO; se esgotar (erro transitório), tenta o RESERVA — também com
   * retry/backoff. Erro permanente (400/401/403) NÃO tenta reserva (o request é que está
   * ruim). Loga cada retry, cada troca de modelo e a exaustão total (pontos de falha).
   */
  async chatCompletion(request: OpenRouterChatRequest): Promise<OpenRouterChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;

    const { fallbackModels, ...wire } = request;
    // cadeia de modelos: primário + reservas, sem duplicatas/vazios.
    const chain = [wire.model, ...(fallbackModels ?? [])].filter((m, i, a) => m && a.indexOf(m) === i);

    let lastError: unknown;
    for (let mi = 0; mi < chain.length; mi += 1) {
      const model = chain[mi]!;
      // `usage.include` p/ garantir custo real no metering (§11); `model` = o da vez.
      const body = JSON.stringify({ ...wire, model, usage: { include: true } });
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        try {
          return await this.attempt(url, headers, body);
        } catch (error) {
          lastError = error;
          const retryable =
            error instanceof LLMProviderError && (error.kind === "rate_limited" || error.kind === "upstream");
          if (!retryable) throw error; // permanente → nem retry nem reserva
          if (attempt < this.maxRetries) {
            this.logger?.warn(
              { model, attempt: attempt + 1, maxRetries: this.maxRetries, err: String(error) },
              "openrouter:retry após erro transitório",
            );
            await this.sleepFn(backoffDelay(attempt));
            continue;
          }
          // esgotou os retries deste modelo → próximo da cadeia (ou fim).
          const next = chain[mi + 1];
          this.logger?.warn(
            { model, ...(next ? { nextModel: next } : {}), err: String(error) },
            next
              ? "openrouter:modelo esgotou retries — tentando reserva"
              : "openrouter:todos os modelos esgotaram os retries",
          );
        }
      }
    }
    throw lastError instanceof Error ? lastError : new LLMProviderError("upstream", "falha desconhecida");
  }

  /**
   * Fallback best-effort: busca o custo real de uma generation já concluída
   * (`GET /generation?id=...`). Usado quando `.bindTools()` no LangChain suprime
   * `response_metadata.usage` (o custo some, mas o `AIMessage.id` sobrevive — ver
   * `apps/worker/src/graphs/whatsapp-conversation/nodes.ts`). Nunca lança — falha
   * (rede/timeout/4xx/5xx/shape inesperado) = `undefined`, mesma convenção de
   * "custo ausente ≠ zero" do resto do cliente. 1 tentativa, sem retry/backoff:
   * canal secundário best-effort, não a chamada crítica de chat.
   */
  async getGenerationCost(generationId: string): Promise<number | undefined> {
    const url = `${this.baseUrl}/generation?id=${encodeURIComponent(generationId)}`;
    try {
      const res = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(GENERATION_LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data?: { total_cost?: unknown } };
      const cost = body.data?.total_cost;
      return typeof cost === "number" ? cost : undefined;
    } catch {
      return undefined;
    }
  }

  private async attempt(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<OpenRouterChatResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body,
        // timeout por tentativa: sem isto o fetch do Node espera pra sempre e uma call
        // travada no provider pendura o run inteiro. Abort → cai no catch (transitório) → retry.
        ...(this.requestTimeoutMs > 0 ? { signal: AbortSignal.timeout(this.requestTimeoutMs) } : {}),
      });
    } catch (cause) {
      // erro de rede/DNS/conexão/timeout → transitório (retryable).
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
