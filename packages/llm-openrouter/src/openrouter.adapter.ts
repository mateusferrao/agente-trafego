import type {
  LLMCompletion,
  LLMContentPart,
  LLMMessage,
  LLMProviderPort,
  LLMReasoning,
  LLMRequest,
  LLMUsage,
} from "@trafego/shared/ports";
import { LLMProviderError } from "@trafego/shared/ports";
import { sleep } from "@trafego/shared";
import {
  OpenRouterClient,
  type OpenRouterChatRequest,
  type OpenRouterChatResponse,
  type OpenRouterContentPart,
  type OpenRouterMessage,
  type OpenRouterUsage,
} from "./client.js";

export interface OpenRouterAdapterDeps {
  readonly client: OpenRouterClient;
  /** retentativas de PARSE/validação do structured output (default 2). O retry de
   *  REDE fica no client; este re-chama o LLM quando o JSON é inválido/trunca/falha
   *  o schema — em vez de descartar a análise. */
  readonly structuredMaxRetries?: number;
  /** injeção p/ testes do backoff entre retentativas de parse. */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_SCHEMA_NAME = "structured_output";
const DEFAULT_STRUCTURED_MAX_RETRIES = 2;
/** Backoff curto entre retentativas de parse (o de rede já tem o seu no client). */
const STRUCTURED_RETRY_DELAY_MS = 400;

/**
 * Adapter OpenRouter da `LLMProviderPort` (§5/§11).
 * 1 gateway multimodal; retorna `usage` com **custo real** do provider (base do
 * metering/markup). Suporta image parts (visão de criativo, 3b). Structured output
 * via `response_format: json_schema` (strict).
 */
export class OpenRouterAdapter implements LLMProviderPort {
  private readonly client: OpenRouterClient;
  private readonly structuredMaxRetries: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(deps: OpenRouterAdapterDeps) {
    this.client = deps.client;
    this.structuredMaxRetries = deps.structuredMaxRetries ?? DEFAULT_STRUCTURED_MAX_RETRIES;
    this.sleepFn = deps.sleepFn ?? sleep;
  }

  async complete(request: LLMRequest): Promise<LLMCompletion<string>> {
    const response = await this.client.chatCompletion(this.toChatRequest(request));
    return { output: this.firstContent(response.choices), usage: this.mapUsage(response.usage) };
  }

  async completeStructured<T>(request: LLMRequest): Promise<LLMCompletion<T>> {
    if (!request.responseSchema) {
      throw new LLMProviderError("invalid_request", "completeStructured exige responseSchema");
    }
    const chatRequest: OpenRouterChatRequest = {
      ...this.toChatRequest(request),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.responseSchemaName ?? DEFAULT_SCHEMA_NAME,
          strict: true,
          schema: request.responseSchema,
        },
      },
    };
    // Retry de PARSE/validação: JSON inválido, truncado ou que falha o schema (`validate`)
    // re-chama o LLM em vez de descartar. O retry de REDE/429/5xx fica no client.
    let lastError: LLMProviderError | undefined;
    for (let attempt = 0; attempt <= this.structuredMaxRetries; attempt += 1) {
      try {
        return this.parseStructured<T>(await this.client.chatCompletion(chatRequest), request);
      } catch (error) {
        if (!(error instanceof LLMProviderError) || error.kind !== "parse_error") throw error;
        lastError = error;
        if (attempt === this.structuredMaxRetries) throw error;
        await this.sleepFn(STRUCTURED_RETRY_DELAY_MS);
      }
    }
    throw lastError ?? new LLMProviderError("parse_error", "structured output falhou após retries");
  }

  /** Extrai + valida o output estruturado de UMA resposta. Falhas → `parse_error` (retryable). */
  private parseStructured<T>(response: OpenRouterChatResponse, request: LLMRequest): LLMCompletion<T> {
    const finishReason = response.choices[0]?.finish_reason;
    // Truncou no maxTokens (comum com modelos de reasoning, que gastam o orçamento
    // "pensando" antes do JSON) → erro claro e acionável, não "JSON inválido" genérico.
    if (finishReason === "length") {
      throw new LLMProviderError(
        "parse_error",
        "resposta truncada no limite de tokens (finish_reason=length) — aumente ANALYSIS_MAX_OUTPUT_TOKENS ou use um modelo instruct (não-reasoning) para este passo",
      );
    }
    const content = this.firstContent(response.choices);
    const output = parseJson<T>(content, finishReason);
    // Validação de schema (ex.: zod do chamador): output estruturalmente-JSON mas com
    // shape errado → `parse_error` (retryable) em vez de devolver algo que seria descartado.
    if (request.validate && !request.validate(output)) {
      const snippet = content.trim().slice(0, 300).replace(/\s+/g, " ");
      throw new LLMProviderError(
        "parse_error",
        `structured output não passou na validação de schema (finish_reason=${finishReason ?? "?"}): ${snippet}`,
      );
    }
    return { output, usage: this.mapUsage(response.usage) };
  }

  /** Monta o corpo comum do chat request a partir do LLMRequest do domínio. */
  private toChatRequest(request: LLMRequest): OpenRouterChatRequest {
    return {
      model: request.model,
      messages: this.mapMessages(request.messages),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.reasoning ? { reasoning: mapReasoning(request.reasoning) } : {}),
    };
  }

  private firstContent(choices: readonly { message: { content: string | null } }[]): string {
    const content = choices[0]?.message.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new LLMProviderError("upstream", "resposta do OpenRouter sem conteúdo");
    }
    return content;
  }

  /** Converte LLMMessage[] (domínio) → mensagens OpenRouter (com image parts). */
  mapMessages(messages: readonly LLMMessage[]): OpenRouterMessage[] {
    return messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : m.content.map((p) => this.mapPart(p)),
    }));
  }

  /** Mapeia uma parte de conteúdo do domínio p/ o formato OpenRouter. */
  mapPart(part: LLMContentPart): OpenRouterContentPart {
    if (part.type === "text") return { type: "text", text: part.text };
    return { type: "image_url", image_url: { url: part.imageUrl } };
  }

  /** Extrai `usage` com custo real reportado pelo OpenRouter (custo ausente ≠ 0). */
  mapUsage(usage: OpenRouterUsage | undefined): LLMUsage {
    const cached = usage?.prompt_tokens_details?.cached_tokens;
    return {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      ...(typeof cached === "number" ? { cachedTokens: cached } : {}),
      ...(typeof usage?.cost === "number" ? { costUsd: usage.cost } : {}),
    };
  }
}

/**
 * Traduz o controle de reasoning do domínio → parâmetro `reasoning` do OpenRouter.
 * `effort:"off"` desliga (`enabled:false`); senão passa effort/max_tokens/exclude.
 */
function mapReasoning(r: LLMReasoning): Record<string, unknown> {
  if (r.effort === "off") return { enabled: false };
  return {
    ...(r.effort ? { effort: r.effort } : {}),
    ...(r.maxTokens !== undefined ? { max_tokens: r.maxTokens } : {}),
    ...(r.exclude ? { exclude: true } : {}),
  };
}

/**
 * Parse tolerante do JSON do structured output (extrai o objeto se vier cercado).
 * No erro, carrega diagnóstico: `finish_reason` (`length` = truncado no maxTokens)
 * + tamanho + trecho do conteúdo — pra distinguir truncamento de formato inválido.
 */
function parseJson<T>(content: string, finishReason?: string): T {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        // cai no throw abaixo
      }
    }
    const snippet = trimmed.slice(0, 300).replace(/\s+/g, " ");
    throw new LLMProviderError(
      "parse_error",
      `structured output não é JSON válido (finish_reason=${finishReason ?? "?"}, len=${content.length}): ${snippet}`,
    );
  }
}
