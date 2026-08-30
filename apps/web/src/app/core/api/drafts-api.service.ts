import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type {
  CreativeAssetOutput,
  DeliveryEstimateInput,
  DeliveryEstimateOutput,
  DraftApprovalOutput,
  GeoSearchResultOutput,
  InterestSearchResultOutput,
  ScaleWinnerInput,
  ScaleWinnerOutput,
  ServingCreativeOutput,
  SetDraftCreativeInput,
  SetDraftCreativeOutput,
  SetDraftTargetingInput,
  SetDraftTargetingOutput,
  UpdateDraftInput,
  UpdateDraftOutput,
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

  /** `PATCH /api/accounts/:id/drafts/:draftId` — edição consolidada do rascunho (painel). Só os
   *  campos alterados. Erro do núcleo → 422 com mensagem amigável (o componente mostra o toast). */
  updateDraft(accountId: string, draftId: string, input: UpdateDraftInput): Observable<UpdateDraftOutput> {
    return this.patch<UpdateDraftOutput, UpdateDraftInput>(
      ['/accounts', accountId, 'drafts', draftId],
      input,
    );
  }

  /** `GET /api/accounts/:id/creatives` — biblioteca de criativos da conta. */
  listCreatives(accountId: string): Observable<CreativeAssetOutput[]> {
    return this.get<CreativeAssetOutput[]>(['/accounts', accountId, 'creatives']);
  }

  /** `GET /api/accounts/:id/serving-creatives` — anúncios ao vivo (reuse no picker; só vídeo). */
  listServingCreatives(accountId: string): Observable<ServingCreativeOutput[]> {
    return this.get<ServingCreativeOutput[]>(['/accounts', accountId, 'serving-creatives']);
  }

  /** `POST /api/accounts/:id/drafts/:draftId/targeting` — alterna o público (reuse × amplo). */
  setDraftTargeting(
    accountId: string,
    draftId: string,
    input: SetDraftTargetingInput,
  ): Observable<SetDraftTargetingOutput> {
    return this.post<SetDraftTargetingOutput, SetDraftTargetingInput>(
      ['/accounts', accountId, 'drafts', draftId, 'targeting'],
      input,
    );
  }

  /** `POST /api/accounts/:id/drafts/:draftId/delivery-estimate` — alcance do público em edição
   *  (Slice 7). Debounce fica no componente. `note` null = Meta não estimou / abaixo do piso. */
  estimateDelivery(accountId: string, draftId: string, input: DeliveryEstimateInput): Observable<DeliveryEstimateOutput> {
    return this.post<DeliveryEstimateOutput, DeliveryEstimateInput>(
      ['/accounts', accountId, 'drafts', draftId, 'delivery-estimate'],
      input,
    );
  }

  /** `GET /api/accounts/:id/targeting/geo-search?q=...` — autocomplete de cidade/região/país
   *  (Fase 1, subfatia 3b). Debounce fica no componente; aqui é só a chamada tipada. */
  searchGeo(accountId: string, q: string): Observable<GeoSearchResultOutput[]> {
    return this.get<GeoSearchResultOutput[]>(['/accounts', accountId, 'targeting', 'geo-search'], { params: { q } });
  }

  /** `GET /api/accounts/:id/targeting/interest-search?q=...` — autocomplete de interesses
   *  (Fase 2, subfatia 4). Debounce fica no componente; aqui é só a chamada tipada. */
  searchInterests(accountId: string, q: string): Observable<InterestSearchResultOutput[]> {
    return this.get<InterestSearchResultOutput[]>(['/accounts', accountId, 'targeting', 'interest-search'], { params: { q } });
  }

  /** URL da rota autenticada de blob (preview) — mesma origem/proxy da API. */
  creativeBlobUrl(accountId: string, assetId: string): string {
    return this.resolveUrl(['/accounts', accountId, 'creatives', assetId, 'blob']);
  }

  /** URL da miniatura do criativo do rascunho (card de aprovação) — proxy autenticado; reuse
   *  busca fresco da Meta, upload serve o blob. Cacheada por ETag no browser. `version` (opcional)
   *  = cache-buster: a URL é estável por rascunho, então trocar o criativo não re-buscaria a img
   *  sozinho; bumpar a versão muda a URL e força o refetch. */
  draftCreativeThumbUrl(accountId: string, draftId: string, version = 0): string {
    const url = this.resolveUrl(['/accounts', accountId, 'drafts', draftId, 'creative', 'thumb']);
    return version > 0 ? `${url}?v=${version}` : url;
  }

  /** `DELETE /api/accounts/:id/creatives/:assetId` — exclui um criativo (híbrido): em uso →
   *  ARQUIVA (`archived:true`, some da biblioteca, não quebra Meta/rascunho); livre → apaga
   *  (`archived:false`). Nunca 409. O componente troca o toast conforme `archived`. */
  deleteCreative(accountId: string, assetId: string): Observable<{ ok: true; archived: boolean }> {
    return this.delete<{ ok: true; archived: boolean }>(['/accounts', accountId, 'creatives', assetId]);
  }

  /** `POST /api/accounts/:id/creatives/upload` — sobe criativo (multipart, imagem OU vídeo) → asset.
   *  FormData: o HttpClient seta o multipart boundary sozinho (não forçar Content-Type). */
  uploadCreative(accountId: string, file: File): Observable<UploadCreativeOutput> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.post<UploadCreativeOutput, FormData>(['/accounts', accountId, 'creatives', 'upload'], form);
  }
}
