import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type {
  ConnectionAccountsOutput,
  ConnectionOutput,
  CreateConnectionInput,
  CreateConnectionOutput,
  SelectAccountsInput,
  SyncOutput,
} from './generated';

/**
 * Conexões com sistemas externos (`/api/connections/*`): conectar (cola token →
 * cria a conexão dona do token), listar, gerir contas (multi-seleção) e
 * sincronizar (redescobrir). A conta de anúncio nasce gerível a partir daqui.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionsApiService extends BaseApiService {
  /** `POST /api/connections` — valida o token, cria a conexão e lista contas. */
  connect(body: CreateConnectionInput): Observable<CreateConnectionOutput> {
    return this.post<CreateConnectionOutput, CreateConnectionInput>('/connections', body);
  }

  /** `GET /api/connections` — conexões da org. */
  list(): Observable<ConnectionOutput[]> {
    return this.get<ConnectionOutput[]>('/connections');
  }

  /** `GET /api/connections/:id/accounts` — contas acessíveis + geridas. */
  accounts(connectionId: string): Observable<ConnectionAccountsOutput> {
    return this.get<ConnectionAccountsOutput>(['/connections', connectionId, 'accounts']);
  }

  /** `POST /api/connections/:id/accounts/select` — aplica a multi-seleção do dono. */
  select(connectionId: string, body: SelectAccountsInput): Observable<ConnectionAccountsOutput> {
    return this.post<ConnectionAccountsOutput, SelectAccountsInput>(
      ['/connections', connectionId, 'accounts', 'select'],
      body,
    );
  }

  /** `POST /api/connections/:id/sync` — redescobre e reconcilia as contas. */
  sync(connectionId: string): Observable<SyncOutput> {
    return this.post<SyncOutput, Record<string, never>>(['/connections', connectionId, 'sync'], {});
  }
}
