import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, of, type Observable } from 'rxjs';
import { ConnectionsApiService } from '@core/api/connections-api.service';
import { CONNECTOR_KEY } from '../catalog/provider-catalog';
import type { ConnectResult } from '../domain/connect-result';
import type {
  ConnectSelectContext,
  ConnectorStrategy,
  CredentialFormSpec,
  CredentialSubmitContext,
} from './connector-strategy';

/** Nome do campo do form de credencial (o System User token). */
const TOKEN_FIELD = 'token';

/**
 * Connector Meta Ads via **paste-token** (System User token — sem OAuth/App Review,
 * §9). Fluxo: colar token → `submitCredentials` cria a **conexão** (dona do token
 * cifrado no backend) e lista as contas (`select`) → `selectTarget` seleciona a
 * conta escolhida naquela conexão (via `connectionId` guardado entre os passos — o
 * token NÃO trafega de novo; fica no backend).
 */
@Injectable({ providedIn: 'root' })
export class MetaAdsConnector implements ConnectorStrategy {
  readonly key = CONNECTOR_KEY.metaAds;
  readonly introHint =
    'Você vai colar um token de acesso da Meta (System User token) para o agente ler suas campanhas.';
  readonly assurances = [
    'Não armazenamos sua senha — apenas o token de acesso autorizado, criptografado.',
    'Você pode desconectar a qualquer momento.',
  ];

  readonly credentialForm: CredentialFormSpec = {
    title: 'Conectar Meta Ads',
    description: 'Cole o token de acesso gerado no Gerenciador de Negócios da Meta.',
    fields: [
      {
        name: TOKEN_FIELD,
        label: 'Token de acesso',
        secret: true,
        placeholder: 'Cole aqui o token',
        helpText: 'A partir dele listamos as contas de anúncio que você pode conectar.',
      },
    ],
    submitLabel: 'Validar',
  };

  private readonly api = inject(ConnectionsApiService);
  /**
   * Conexão criada no `submitCredentials`, consumida no `selectTarget`. Estado ok:
   * o dialog é modal (um fluxo por vez) e a conexão é a mesma entre os dois passos.
   */
  private pendingConnectionId: string | null = null;

  submitCredentials(ctx: CredentialSubmitContext): Observable<ConnectResult> {
    const token = ctx.values[TOKEN_FIELD] ?? '';
    return this.api.connect({ token }).pipe(
      map((res): ConnectResult => {
        this.pendingConnectionId = res.connection.id;
        return {
          kind: 'select',
          targets: res.available.map((a) => ({
            id: a.id,
            label: a.name,
            ...(a.currency ? { sublabel: a.currency } : {}),
          })),
        };
      }),
      catchError((error: unknown) => of(toConnectError(error))),
    );
  }

  selectTarget(ctx: ConnectSelectContext): Observable<ConnectResult> {
    const connectionId = this.pendingConnectionId;
    if (!connectionId) {
      return of<ConnectResult>({ kind: 'error', message: 'Sessão de conexão expirou. Comece de novo.', recoverable: true });
    }
    return this.api.select(connectionId, { adAccountIds: [ctx.targetId] }).pipe(
      map((): ConnectResult => {
        this.pendingConnectionId = null; // conexão concluída — não segurar o id.
        return { kind: 'success', integrationId: connectionId };
      }),
      catchError((error: unknown) => of(toConnectError(error))),
    );
  }
}

/** Erro amigável: usa a mensagem do backend (já tratada) ou um fallback claro. */
function toConnectError(error: unknown): ConnectResult {
  const fromServer =
    error instanceof HttpErrorResponse && typeof error.error?.message === 'string'
      ? error.error.message
      : null;
  return {
    kind: 'error',
    message: fromServer ?? 'Não consegui concluir agora. Verifique sua conexão e tente de novo.',
    recoverable: true,
  };
}
