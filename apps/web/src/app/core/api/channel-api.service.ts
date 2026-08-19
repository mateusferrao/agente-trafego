import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import { silentApiContext } from './api-request.interceptor';
import type {
  ChannelStateOutput,
  ConfirmVerificationInput,
  ConfirmVerificationOutput,
  RecipientOutput,
  RemoveRecipientOutput,
  StartVerificationInput,
  StartVerificationOutput,
} from './generated';

/**
 * Onboarding do canal WhatsApp (3b): conectar a instância por QR, ler o estado e
 * verificar o número do dono por código (opt-in — §9). Tudo org-scoped no servidor.
 */
@Injectable({ providedIn: 'root' })
export class ChannelApiService extends BaseApiService {
  /** `POST /api/channels/connect` — cria/conecta a instância e devolve o QR. */
  connect(): Observable<ChannelStateOutput> {
    return this.post<ChannelStateOutput, Record<string, never>>(['/channels', 'connect'], {});
  }

  /** `POST /api/channels/disconnect` — logout do número (mantém a instância). */
  disconnect(): Observable<ChannelStateOutput> {
    return this.post<ChannelStateOutput, Record<string, never>>(['/channels', 'disconnect'], {});
  }

  /**
   * `GET /api/channels/status` — estado atual do canal (para polling do QR).
   * `silent` suprime o toast global de erro: o polling reage a blip transitório
   * pela própria UI (estado "instável" + toast único ao esgotar), sem spammar.
   */
  status(silent = false): Observable<ChannelStateOutput> {
    return this.get<ChannelStateOutput>(
      ['/channels', 'status'],
      silent ? { context: silentApiContext() } : {},
    );
  }

  /** `POST /api/contacts/verify/start` — envia o código pelo WhatsApp. */
  startVerification(input: StartVerificationInput): Observable<StartVerificationOutput> {
    return this.post<StartVerificationOutput, StartVerificationInput>(
      ['/contacts', 'verify', 'start'],
      input,
    );
  }

  /** `POST /api/contacts/verify/confirm` — confirma o código digitado no site. */
  confirmVerification(input: ConfirmVerificationInput): Observable<ConfirmVerificationOutput> {
    return this.post<ConfirmVerificationOutput, ConfirmVerificationInput>(
      ['/contacts', 'verify', 'confirm'],
      input,
    );
  }

  /** `GET /api/contacts/recipient` — destinatário atual (verificado) da org. */
  getRecipient(): Observable<RecipientOutput> {
    return this.get<RecipientOutput>(['/contacts', 'recipient']);
  }

  /** `POST /api/contacts/recipient/remove` — remove o destinatário (trocar número). */
  removeRecipient(): Observable<RemoveRecipientOutput> {
    return this.post<RemoveRecipientOutput, Record<string, never>>(
      ['/contacts', 'recipient', 'remove'],
      {},
    );
  }
}
