/**
 * Cliente HTTP do Meta Graph API.
 *
 * Responsabilidades:
 * - Injetar a versão do Graph (`META_GRAPH_VERSION`, ex: v26.0) na URL base.
 * - Anexar o `access_token` (System User token já descriptografado).
 * - Ler os headers de uso (`X-Business-Use-Case-Usage`) p/ alimentar o governor.
 * - Suportar Batch API (≤50 sub-requests por chamada HTTP).
 *
 * A casca injeta o token; o adapter nunca toca no vault.
 */

/** Percentuais de uso reportados pela Meta por business use-case. */
export interface BusinessUseCaseUsage {
  readonly callCountPct: number; // 0..100
  readonly totalCputimePct: number; // 0..100
  readonly totalTimePct: number; // 0..100
  readonly estimatedTimeToRegainAccessSec?: number;
}

export interface GraphResponse<T> {
  readonly data: T;
  /** parse de X-Business-Use-Case-Usage por ad_account (quando presente). */
  readonly usage?: Readonly<Record<string, BusinessUseCaseUsage>>;
}

export interface GraphRequest {
  readonly method: "GET" | "POST" | "DELETE";
  /** path relativo, ex: "act_123/campaigns" ou "me/adaccounts". */
  readonly path: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly accessToken: string;
}

/** Uma sub-request dentro de um Batch API call. */
export interface BatchSubRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly relativeUrl: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface MetaClientOptions {
  /** ex: "v26.0" — lido de META_GRAPH_VERSION. */
  readonly graphVersion: string;
  readonly baseUrl?: string; // default https://graph.facebook.com
  readonly appSecret?: string; // opcional: appsecret_proof
}

export class MetaGraphClient {
  private readonly graphVersion: string;
  private readonly baseUrl: string;
  private readonly appSecret: string | undefined;

  constructor(options: MetaClientOptions) {
    this.graphVersion = options.graphVersion;
    this.baseUrl = options.baseUrl ?? "https://graph.facebook.com";
    this.appSecret = options.appSecret;
  }

  /** Monta a URL versionada: `${baseUrl}/${graphVersion}/${path}`. */
  buildUrl(path: string): string {
    // TODO: normalizar barras + validar path
    throw new Error("not implemented");
  }

  /** Executa uma request única. Faz parse dos headers de uso. */
  request<T>(req: GraphRequest): Promise<GraphResponse<T>> {
    // TODO: fetch versionado, anexar access_token (+ appsecret_proof se houver),
    //       mapear erros (ex: code 190 = token inválido) p/ exceção tipada da casca,
    //       ler header X-Business-Use-Case-Usage → parseUsageHeader.
    throw new Error("not implemented");
  }

  /** Batch API: agrupa até 50 sub-requests em 1 chamada HTTP. */
  batch(accessToken: string, requests: readonly BatchSubRequest[]): Promise<GraphResponse<unknown[]>> {
    // TODO: POST / com batch=JSON, particionar em lotes ≤50, agregar respostas.
    throw new Error("not implemented");
  }

  /** Faz parse do header X-Business-Use-Case-Usage em um mapa por ad_account. */
  parseUsageHeader(headerValue: string | null): Record<string, BusinessUseCaseUsage> {
    // TODO: JSON.parse + mapear campos call_count/total_cputime/total_time.
    throw new Error("not implemented");
  }
}
