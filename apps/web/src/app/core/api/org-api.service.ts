import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import { silentApiContext } from './api-request.interceptor';
import type {
  AccessStatusOutput,
  CostsOutput,
  MarketReferenceOutput,
  OrgOutput,
  RenameOrgInput,
  SetMarketReferenceInput,
  SetTimezoneInput,
} from './generated';

/** Endpoints de organização + billing (`/api/orgs`, `/api/billing/access-status`). */
@Injectable({ providedIn: 'root' })
export class OrgApiService extends BaseApiService {
  /** `GET /api/orgs` — organizações do usuário (org switcher do shell). */
  listOrgs(): Observable<OrgOutput[]> {
    return this.get<OrgOutput[]>('/orgs');
  }

  /** `PATCH /api/orgs/current` — renomeia a org ativa (só owner). */
  renameOrg(body: RenameOrgInput): Observable<OrgOutput> {
    return this.patch<OrgOutput, RenameOrgInput>('/orgs/current', body);
  }

  /** `GET /api/orgs/current` — org ativa (nome + fuso). */
  currentOrg(): Observable<OrgOutput> {
    return this.get<OrgOutput>('/orgs/current');
  }

  /** `PATCH /api/orgs/current/timezone` — muda o fuso da org (só owner). */
  setTimezone(timezone: string): Observable<OrgOutput> {
    return this.patch<OrgOutput, SetTimezoneInput>('/orgs/current/timezone', { timezone });
  }

  /** `GET /api/orgs/current/market-reference` — referência de mercado padrão da org. */
  marketReference(): Observable<MarketReferenceOutput> {
    return this.get<MarketReferenceOutput>('/orgs/current/market-reference');
  }

  /** `PUT /api/orgs/current/market-reference` — define a referência de mercado (só owner). */
  setMarketReference(body: SetMarketReferenceInput): Observable<MarketReferenceOutput> {
    return this.put<MarketReferenceOutput, SetMarketReferenceInput>('/orgs/current/market-reference', body);
  }

  /** `GET /api/billing/access-status` — status do acesso beta da org atual. */
  accessStatus(): Observable<AccessStatusOutput> {
    return this.get<AccessStatusOutput>('/billing/access-status');
  }

  /** `GET /api/billing/costs` — custo (COGS) do owner num range por dia (since/until). */
  costs(since?: string, until?: string): Observable<CostsOutput> {
    return this.get<CostsOutput>('/billing/costs', {
      context: silentApiContext(),
      params: { since, until },
    });
  }
}
