import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import { silentApiContext } from './api-request.interceptor';
import type {
  ChannelGroupStateOutput,
  ChannelStateOutput,
  ConfirmVerificationInput,
  ConfirmVerificationOutput,
  GroupsListOutput,
  RecipientOutput,
  RemoveRecipientOutput,
  SetGroupInput,
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

  /**
   * `GET /api/channels/groups` — grupos que o número já integra + o ativo da org
   * (se algum). `silent`: carga de fundo ao abrir a tela.
   */
  listGroups(silent = false): Observable<GroupsListOutput> {
    return this.get<GroupsListOutput>(
      ['/channels', 'groups'],
      silent ? { context: silentApiContext() } : {},
    );
  }

  /** `PUT /api/channels/group` — define/ativa o grupo (1 por org, como o número). */
  setGroup(input: SetGroupInput): Observable<ChannelGroupStateOutput> {
    return this.put<ChannelGroupStateOutput, SetGroupInput>(['/channels', 'group'], input);
  }

  /** `DELETE /api/channels/group` — desliga o grupo (soft, mantém o registro). */
  disableGroup(): Observable<ChannelGroupStateOutput> {
    return this.delete<ChannelGroupStateOutput>(['/channels', 'group']);
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

  /**
   * `GET /api/contacts/recipient` — destinatário atual (verificado) da org.
   * `silent` suprime o toast global (carga em background ao abrir a tela).
   */
  getRecipient(silent = false): Observable<RecipientOutput> {
    return this.get<RecipientOutput>(
      ['/contacts', 'recipient'],
      silent ? { context: silentApiContext() } : {},
    );
  }

  /** `POST /api/contacts/recipient/remove` — remove o destinatário (trocar número). */
  removeRecipient(): Observable<RemoveRecipientOutput> {
    return this.post<RemoveRecipientOutput, Record<string, never>>(
      ['/contacts', 'recipient', 'remove'],
      {},
    );
  }
}
