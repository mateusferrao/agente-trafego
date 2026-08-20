import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type {
  ApprovalOutput,
  ResolveApprovalInput,
  ResolveApprovalOutput,
  RevertibleActionOutput,
} from './generated';

/**
 * Aprovações (HITL via site, 5b): caixa de entrada cross-conta + resolver por ação.
 * Aprovar enfileira o apply-service (worker re-checa fresco); rejeitar resolve direto.
 */
@Injectable({ providedIn: 'root' })
export class ApprovalsApiService extends BaseApiService {
  /** `GET /api/approvals` — pendentes da org (todas as contas). */
  listPending(): Observable<ApprovalOutput[]> {
    return this.get<ApprovalOutput[]>(['/approvals']);
  }

  /** `POST /api/approvals/:id/resolve` — aprovar (enfileira) ou rejeitar (direto). */
  resolve(id: string, decision: ResolveApprovalInput['decision']): Observable<ResolveApprovalOutput> {
    return this.post<ResolveApprovalOutput, ResolveApprovalInput>(
      ['/approvals', id, 'resolve'],
      { decision },
    );
  }

  /** `GET /api/approvals/revertible` — ações aplicadas ainda acionáveis (cross-conta). */
  listRevertible(): Observable<RevertibleActionOutput[]> {
    return this.get<RevertibleActionOutput[]>(['/approvals', 'revertible']);
  }
}
