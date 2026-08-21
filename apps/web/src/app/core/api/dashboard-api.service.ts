import { Injectable } from "@angular/core";
import type { Observable } from "rxjs";
import { BaseApiService } from "./base-api.service";
import { silentApiContext } from "./api-request.interceptor";
import type { DashboardOutput, LiveMetricsOutput, RefreshDataOutput, TimelineOutput } from "./generated";

/** Filtros da timeline (todos opcionais). */
export interface TimelineOptions {
  readonly types?: readonly string[];
  readonly since?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Painel gerencial + frescura (6a): dados cross-conta + KPIs ao vivo + timeline. */
@Injectable({ providedIn: "root" })
export class DashboardApiService extends BaseApiService {
  /** `GET /api/dashboard` — painel cross-conta (pendências/atenção/atividade/panorama). */
  dashboard(): Observable<DashboardOutput> {
    return this.get<DashboardOutput>(["/dashboard"]);
  }

  /** `GET /api/accounts/:id/live-metrics` — KPIs ao vivo + as-of. Secundário → silencioso. */
  liveMetrics(accountId: string): Observable<LiveMetricsOutput> {
    return this.get<LiveMetricsOutput>(["/accounts", accountId, "live-metrics"], {
      context: silentApiContext(),
    });
  }

  /** `POST /api/accounts/:id/refresh-data` — força sync-only ("atualizar agora"). */
  refreshData(accountId: string): Observable<RefreshDataOutput> {
    return this.post<RefreshDataOutput, Record<string, never>>(["/accounts", accountId, "refresh-data"], {});
  }

  /** `GET /api/accounts/:id/timeline` — feed de auditoria (paginado + filtros). */
  timeline(accountId: string, opts: TimelineOptions = {}): Observable<TimelineOutput> {
    const types = opts.types && opts.types.length > 0 ? opts.types.join(",") : undefined;
    return this.get<TimelineOutput>(["/accounts", accountId, "timeline"], {
      context: silentApiContext(),
      params: { types, since: opts.since, limit: opts.limit, offset: opts.offset },
    });
  }
}
