import { HttpClient, HttpContext, HttpHeaders, HttpParams } from '@angular/common/http';
import { inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Base HTTP dos serviços de API. Envolve o `HttpClient` do Angular com:
 *  - `withCredentials: true` em TODA requisição (o cookie de sessão é HttpOnly,
 *    setado pelo servidor; o front nunca lê/parseia o cookie — CLAUDE.md §12);
 *  - resolução de URL a partir do prefixo `environment.apiBaseUrl` (+ `resourcePath`).
 *
 * Não há client gerado (kubb gera só TIPOS). Cada feature estende esta base e
 * expõe métodos tipados sobre os tipos do contrato em `core/api/generated`.
 */
export type ApiRequestOptions = {
  context?: HttpContext;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean | null | undefined>;
};

export type ApiPathSegment = string | number;
export type ApiPath = string | readonly ApiPathSegment[];

export abstract class BaseApiService {
  protected readonly http = inject(HttpClient);
  protected readonly baseUrl = environment.apiBaseUrl;
  /** Sub-caminho do recurso (ex.: '/auth'), prefixado a paths relativos. */
  protected readonly resourcePath: string = '';

  protected get<TResult>(path: ApiPath = '', options: ApiRequestOptions = {}): Observable<TResult> {
    return this.request<TResult>('GET', path, undefined, options);
  }

  protected post<TResult, TBody = unknown>(
    path: ApiPath,
    body: TBody,
    options: ApiRequestOptions = {},
  ): Observable<TResult> {
    return this.request<TResult>('POST', path, body, options);
  }

  protected patch<TResult, TBody = unknown>(
    path: ApiPath,
    body: TBody,
    options: ApiRequestOptions = {},
  ): Observable<TResult> {
    return this.request<TResult>('PATCH', path, body, options);
  }

  protected put<TResult, TBody = unknown>(
    path: ApiPath,
    body: TBody,
    options: ApiRequestOptions = {},
  ): Observable<TResult> {
    return this.request<TResult>('PUT', path, body, options);
  }

  private request<TResult>(
    method: string,
    path: ApiPath,
    body: unknown,
    options: ApiRequestOptions,
  ): Observable<TResult> {
    return this.http.request<TResult>(method, this.resolveUrl(path), {
      body,
      context: options.context,
      headers: new HttpHeaders(options.headers ?? {}),
      params: this.createParams(options.params),
      withCredentials: true,
    });
  }

  private resolveUrl(path: ApiPath): string {
    const normalized = typeof path === 'string' ? path : this.joinPath(path);
    const withResource = normalized.startsWith('/')
      ? normalized
      : this.joinPath([this.resourcePath, normalized]);
    const suffix = withResource.startsWith('/') ? withResource : `/${withResource}`;
    return `${this.baseUrl}${suffix}`;
  }

  private joinPath(segments: readonly ApiPathSegment[]): string {
    return segments
      .map((segment) => String(segment))
      .filter((segment) => segment !== '')
      .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
  }

  private createParams(params: ApiRequestOptions['params']): HttpParams {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === null || value === undefined) {
        continue;
      }
      httpParams = httpParams.set(key, String(value));
    }
    return httpParams;
  }
}
