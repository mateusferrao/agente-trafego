export type LLMTextPart = { readonly type: "text"; readonly text: string };
export type LLMImagePart = { readonly type: "image_url"; readonly imageUrl: string };
/** Vídeo multimodal (data-url base64 ou URL) — modelos video-capable (ex: Gemini via OpenRouter). */
export type LLMVideoPart = { readonly type: "video_url"; readonly videoUrl: string };
export type LLMContentPart = LLMTextPart | LLMImagePart | LLMVideoPart;

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | readonly LLMContentPart[];
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
  /**
   * Custo real reportado pelo provider (OpenRouter). **Opcional** de propósito:
   * custo ausente ≠ custo zero — se o provider não reportou, o campo fica ausente
   * (nunca 0, que diria ao billing que a chamada foi grátis).
   */
  readonly costUsd?: number;
}

/**
 * Contexto de metering da chamada (cross-cutting): o decorator de metering usa
 * p/ atribuir o `usage_event` à org/run/tipo, sem estado mutável compartilhado
 * entre runs concorrentes. O adapter do provider ignora este campo.
 */
export interface LLMCallMeta {
  readonly orgId?: string;
  readonly runId?: string;
  /** dimensão do evento de uso (ex: "unit" | "synthesis" | "review" | "message"). */
  readonly type?: string;
}

/**
 * Controle de reasoning (modelos que "pensam" antes de responder). `effort` regula
 * o esforço; `maxTokens` limita o orçamento de reasoning (deixando espaço p/ a
 * resposta dentro do maxTokens total); `exclude` pede pra não retornar o reasoning.
 * `"off"` desliga. O adapter traduz p/ o formato do provider (ignorado por modelos
 * sem reasoning).
 */
export interface LLMReasoning {
  readonly effort?: "off" | "low" | "medium" | "high";
  readonly maxTokens?: number;
  readonly exclude?: boolean;
}

export interface LLMRequest {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  /** structured output: JSON Schema esperado. */
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  /** nome do schema (identifica o structured output p/ o provider). */
  readonly responseSchemaName?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** reasoning (modelos que pensam antes de responder) — ver LLMReasoning. */
  readonly reasoning?: LLMReasoning;
  /**
   * Modelos de RESERVA em ordem. O adapter tenta o `model` com retry/backoff completo;
   * se esgotar (erro transitório do provider), passa ao próximo — também com retry/backoff.
   */
  readonly fallbackModels?: readonly string[];
  /** metering (opcional) — atribui o custo desta chamada à org/run/tipo. */
  readonly meta?: LLMCallMeta;
  /**
   * Validação de schema do output estruturado (opcional). Roda em `completeStructured`
   * DEPOIS do parse de JSON; retorna `false` → a chamada é re-tentada (parse_error)
   * em vez de devolver um objeto que o chamador descartaria. Ex.: `(o) =>
   * meuZodSchema.safeParse(o).success`. Sem isto, só o JSON.parse é validado.
   */
  readonly validate?: (parsed: unknown) => boolean;
}

export interface LLMCompletion<T = string> {
  readonly output: T;
  readonly usage: LLMUsage;
}

/**
 * Falha genérica da borda de LLM — o adapter traduz o erro do provider para esta
 * forma, e a casca decide o que fazer sem conhecer o provider. `rate_limited`/
 * `upstream` são transitórios (o adapter já re-tenta); `invalid_request` é
 * permanente (400/401/403); `parse_error` = output não-parseável no structured.
 */
export type LLMProviderErrorKind = "rate_limited" | "invalid_request" | "upstream" | "parse_error";

export class LLMProviderError extends Error {
  constructor(
    readonly kind: LLMProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LLMProviderError";
  }
}

/**
 * Borda de LLM. Adapter MVP = OpenRouter (1 gateway multimodal).
 * Retorna sempre `usage` com custo real → base do metering/markup.
 */
export interface LLMProviderPort {
  complete(request: LLMRequest): Promise<LLMCompletion<string>>;
  completeStructured<T>(request: LLMRequest): Promise<LLMCompletion<T>>;
}
