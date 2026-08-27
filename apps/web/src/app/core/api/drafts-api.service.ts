import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type { DraftApprovalOutput, ScaleWinnerInput, ScaleWinnerOutput } from './generated';

/**
 * Rascunhos de campanha (Fatia 7): inbox de rascunhos aguardando aprovação + escalar
 * vencedor pelo site. Aprovar/rejeitar reusa ApprovalsApiService (mesma rota de resolve).
 */
@Injectable({ providedIn: 'root' })
export class DraftsApiService extends BaseApiService {
  /** `GET /api/drafts/pending` — rascunhos propostos (card de rascunho, cross-conta). */
  listPending(): Observable<DraftApprovalOutput[]> {
    return this.get<DraftApprovalOutput[]>(['/drafts', 'pending']);
  }

  /** `POST /api/accounts/:id/drafts/scale` — escala um vencedor (rascunho ou ação de budget). */
  scaleWinner(accountId: string, input: ScaleWinnerInput): Observable<ScaleWinnerOutput> {
    return this.post<ScaleWinnerOutput, ScaleWinnerInput>(
      ['/accounts', accountId, 'drafts', 'scale'],
      input,
    );
  }
}
