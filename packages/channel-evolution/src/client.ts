/**
 * Cliente HTTP da Evolution API.
 *
 * - Base: `EVOLUTION_BASE_URL`.
 * - Auth: header `apikey: EVOLUTION_API_KEY` (injetado pela casca).
 * - Endpoints usados: message/sendText, instance/connect, instance/connectionState.
 *
 * A validação do `EVOLUTION_WEBHOOK_SECRET` do inbound é responsabilidade da casca,
 * não deste cliente (§9).
 */

/** Erro tipado da Evolution API (lançado na casca). */
export class EvolutionApiError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "EvolutionApiError";
    this.httpStatus = httpStatus;
  }
}

export interface EvolutionClientOptions {
  readonly baseUrl: string; // EVOLUTION_BASE_URL
  readonly apiKey: string; // EVOLUTION_API_KEY
}

export interface EvolutionRequest {
  readonly method: "GET" | "POST" | "DELETE";
  /** path relativo, ex: "message/sendText/{instance}". */
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

export class EvolutionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: EvolutionClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
  }

  /** Executa uma request contra a Evolution API (anexa header apikey). */
  async request<T>(req: EvolutionRequest): Promise<T> {
    const path = req.path.replace(/^\/+/, "");
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: req.method,
      headers: { apikey: this.apiKey, "content-type": "application/json" },
      ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new EvolutionApiError(`Evolution API ${res.status}: ${text}`, res.status);
    }
    return (text ? (JSON.parse(text) as T) : (undefined as T));
  }
}
