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

import { createHmac } from "node:crypto";

/** Corpo de erro padrão da Graph API. */
export interface MetaErrorBody {
  readonly message?: string;
  readonly type?: string;
  readonly code?: number;
  readonly error_subcode?: number;
  readonly fbtrace_id?: string;
}

/**
 * Erro tipado da Graph API (lançado na casca; mapeado p/ resposta HTTP amigável).
 * `code === 190` = token inválido/revogado → recolar (fluxo completo = fatia 6b).
 */
export class MetaApiError extends Error {
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly httpStatus: number;

  constructor(
    message: string,
    code: number | undefined,
    subcode: number | undefined,
    httpStatus: number,
  ) {
    super(message);
    this.name = "MetaApiError";
    this.code = code;
    this.subcode = subcode;
    this.httpStatus = httpStatus;
  }
}

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

/**
 * Versão pinada da Graph API — **acoplada ao código deste adapter** (escrito p/
 * v26). Não é env: mudar a versão exige revisar o adapter, não só o ambiente.
 */
export const META_GRAPH_VERSION = "v26.0";

export interface MetaClientOptions {
  /** override da versão (default = META_GRAPH_VERSION). */
  readonly graphVersion?: string;
  readonly baseUrl?: string; // default https://graph.facebook.com
  readonly appSecret?: string; // opcional: appsecret_proof (fast-follow)
}

export class MetaGraphClient {
  private readonly graphVersion: string;
  private readonly baseUrl: string;
  private readonly appSecret: string | undefined;

  constructor(options: MetaClientOptions = {}) {
    this.graphVersion = options.graphVersion ?? META_GRAPH_VERSION;
    this.baseUrl = options.baseUrl ?? "https://graph.facebook.com";
    this.appSecret = options.appSecret;
  }

  /** Monta a URL versionada: `${baseUrl}/${graphVersion}/${path}`. */
  buildUrl(path: string): string {
    const clean = path.replace(/^\/+/, "");
    return `${this.baseUrl}/${this.graphVersion}/${clean}`;
  }

  /**
   * Executa uma request única. Token no header `Authorization: Bearer` (nunca na
   * query) + `appsecret_proof` quando há appSecret. Erro não-2xx → `MetaApiError`.
   * Lê `X-Business-Use-Case-Usage` (consumo pelo governor = fatia 2a).
   */
  async request<T>(req: GraphRequest): Promise<GraphResponse<T>> {
    const url = new URL(this.buildUrl(req.path));
    if (req.params) {
      for (const [key, value] of Object.entries(req.params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const secret = this.appSecret;
    if (secret) {
      url.searchParams.set("appsecret_proof", createHmac("sha256", secret).update(req.accessToken).digest("hex"));
    }

    const res = await fetch(url.toString(), {
      method: req.method,
      headers: { Authorization: `Bearer ${req.accessToken}` },
    });
    return this.toGraphResponse<T>(res);
  }

  /**
   * Trata a resposta HTTP: lê como texto primeiro (erro não-JSON — 502/503 HTML,
   * throttling — não pode estourar JSON.parse e sim virar `MetaApiError` com o
   * httpStatus) e mapeia erro Graph → `MetaApiError`.
   */
  private async toGraphResponse<T>(res: Response): Promise<GraphResponse<T>> {
    const text = await res.text();
    if (!res.ok) {
      let error: MetaErrorBody | undefined;
      try {
        error = (JSON.parse(text) as { error?: MetaErrorBody }).error;
      } catch {
        error = undefined;
      }
      throw new MetaApiError(
        error?.message ?? `Erro na Meta Graph API (HTTP ${res.status})`,
        error?.code,
        error?.error_subcode,
        res.status,
      );
    }
    const body = (text ? JSON.parse(text) : {}) as T;
    return { data: body, usage: this.parseUsageHeader(res.headers.get("x-business-use-case-usage")) };
  }

  /** Batch API: agrupa até 50 sub-requests em 1 chamada HTTP. */
  batch(accessToken: string, requests: readonly BatchSubRequest[]): Promise<GraphResponse<unknown[]>> {
    // TODO: POST / com batch=JSON, particionar em lotes ≤50, agregar respostas.
    throw new Error("not implemented");
  }

  /**
   * Parse defensivo do header X-Business-Use-Case-Usage em um mapa por ad_account.
   * Header malformado não derruba a request (o governor da fatia 2a decide o resto).
   */
  parseUsageHeader(headerValue: string | null): Record<string, BusinessUseCaseUsage> {
    if (!headerValue) return {};
    try {
      const raw = JSON.parse(headerValue) as Record<string, Array<Record<string, number>>>;
      const out: Record<string, BusinessUseCaseUsage> = {};
      for (const [account, entries] of Object.entries(raw)) {
        const e = entries?.[0];
        if (!e) continue;
        out[account] = {
          callCountPct: e["call_count"] ?? 0,
          totalCputimePct: e["total_cputime"] ?? 0,
          totalTimePct: e["total_time"] ?? 0,
          ...(e["estimated_time_to_regain_access"] !== undefined
            ? { estimatedTimeToRegainAccessSec: e["estimated_time_to_regain_access"] }
            : {}),
        };
      }
      return out;
    } catch {
      return {};
    }
  }
}
