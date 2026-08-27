import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type {
  CreativeAssetOutput,
  DraftApprovalOutput,
  ScaleWinnerInput,
  ScaleWinnerOutput,
  SetDraftCreativeInput,
  SetDraftCreativeOutput,
  UploadCreativeInput,
  UploadCreativeOutput,
} from './generated';

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

  /** `POST /api/accounts/:id/drafts/:draftId/creative` — troca o criativo do rascunho (picker). */
  setDraftCreative(
    accountId: string,
    draftId: string,
    input: SetDraftCreativeInput,
  ): Observable<SetDraftCreativeOutput> {
    return this.post<SetDraftCreativeOutput, SetDraftCreativeInput>(
      ['/accounts', accountId, 'drafts', draftId, 'creative'],
      input,
    );
  }

  /** `GET /api/accounts/:id/creatives` — biblioteca de criativos da conta. */
  listCreatives(accountId: string): Observable<CreativeAssetOutput[]> {
    return this.get<CreativeAssetOutput[]>(['/accounts', accountId, 'creatives']);
  }

  /** URL da rota autenticada de blob (preview) — mesma origem/proxy da API. */
  creativeBlobUrl(accountId: string, assetId: string): string {
    return this.resolveUrl(['/accounts', accountId, 'creatives', assetId, 'blob']);
  }

  /** `POST /api/accounts/:id/creatives/upload` — sobe imagem (base64) → asset. */
  uploadCreative(accountId: string, input: UploadCreativeInput): Observable<UploadCreativeOutput> {
    return this.post<UploadCreativeOutput, UploadCreativeInput>(
      ['/accounts', accountId, 'creatives', 'upload'],
      input,
    );
  }
}
