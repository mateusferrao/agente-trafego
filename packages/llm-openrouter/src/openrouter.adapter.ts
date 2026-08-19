import type {
  LLMCompletion,
  LLMContentPart,
  LLMMessage,
  LLMProviderPort,
  LLMRequest,
  LLMUsage,
} from "@trafego/shared/ports";
import { LLMProviderError } from "@trafego/shared/ports";
import {
  OpenRouterClient,
  type OpenRouterChatRequest,
  type OpenRouterContentPart,
  type OpenRouterMessage,
  type OpenRouterUsage,
} from "./client.js";

export interface OpenRouterAdapterDeps {
  readonly client: OpenRouterClient;
}

const DEFAULT_SCHEMA_NAME = "structured_output";

/**
 * Adapter OpenRouter da `LLMProviderPort` (§5/§11).
 * 1 gateway multimodal; retorna `usage` com **custo real** do provider (base do
 * metering/markup). Suporta image parts (visão de criativo, 3b). Structured output
 * via `response_format: json_schema` (strict).
 */
export class OpenRouterAdapter implements LLMProviderPort {
  private readonly client: OpenRouterClient;

  constructor(deps: OpenRouterAdapterDeps) {
    this.client = deps.client;
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
    const response = await this.client.chatCompletion(chatRequest);
    const content = this.firstContent(response.choices);
    return { output: parseJson<T>(content), usage: this.mapUsage(response.usage) };
  }

  /** Monta o corpo comum do chat request a partir do LLMRequest do domínio. */
  private toChatRequest(request: LLMRequest): OpenRouterChatRequest {
    return {
      model: request.model,
      messages: this.mapMessages(request.messages),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
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

/** Parse tolerante do JSON do structured output (extrai o objeto se vier cercado). */
function parseJson<T>(content: string): T {
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
    throw new LLMProviderError("parse_error", "structured output não é JSON válido");
  }
}
