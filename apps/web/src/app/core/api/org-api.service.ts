import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type { AccessStatusOutput, OrgOutput, RenameOrgInput } from './generated';

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

  /** `GET /api/billing/access-status` — status do acesso beta da org atual. */
  accessStatus(): Observable<AccessStatusOutput> {
    return this.get<AccessStatusOutput>('/billing/access-status');
  }
}
