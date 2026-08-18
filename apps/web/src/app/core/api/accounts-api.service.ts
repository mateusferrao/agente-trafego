import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type {
  AdAccountOutput,
  ConnectAccountsOutput,
  ConnectTokenInput,
  SelectAccountInput,
} from './generated';

/** Endpoints de contas Meta (`/api/accounts/*`) — onboarding + listagem. */
@Injectable({ providedIn: 'root' })
export class AccountsApiService extends BaseApiService {
  /** `POST /api/accounts/connect` — valida o token e lista as contas acessíveis. */
  connect(body: ConnectTokenInput): Observable<ConnectAccountsOutput> {
    return this.post<ConnectAccountsOutput, ConnectTokenInput>('/accounts/connect', body);
  }

  /** `POST /api/accounts/select` — persiste a conta escolhida (token reenviado). */
  select(body: SelectAccountInput): Observable<AdAccountOutput> {
    return this.post<AdAccountOutput, SelectAccountInput>('/accounts/select', body);
  }

  /** `GET /api/accounts` — contas conectadas da org. */
  list(): Observable<AdAccountOutput[]> {
    return this.get<AdAccountOutput[]>('/accounts');
  }
}
