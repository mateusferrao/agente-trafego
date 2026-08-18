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
  request<T>(req: EvolutionRequest): Promise<T> {
    // TODO: fetch `${baseUrl}/${path}` com header apikey + JSON body; mapear erro p/ exceção.
    throw new Error("not implemented");
  }
}
