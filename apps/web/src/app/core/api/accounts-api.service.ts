import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type { AdAccountOutput } from './generated';

/**
 * Contas de anúncio (`/api/accounts`). Conectar/escolher contas mora no slice
 * `connections` (Integrações); aqui só a listagem das contas sob gestão.
 */
@Injectable({ providedIn: 'root' })
export class AccountsApiService extends BaseApiService {
  /** `GET /api/accounts` — contas sob gestão da org. */
  list(): Observable<AdAccountOutput[]> {
    return this.get<AdAccountOutput[]>('/accounts');
  }
}
