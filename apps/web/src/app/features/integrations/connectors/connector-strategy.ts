import type { Observable } from 'rxjs';
import type { ConnectResult } from '../domain/connect-result';
import type { ProviderCatalogEntry } from '../domain/provider-catalog-entry';

export interface ConnectContext {
  readonly entry: ProviderCatalogEntry;
}

/**
 * Spec genérica de input de credencial (api_key, bearer, token). O dialog renderiza
 * o form a partir disto; o connector decide o que fazer com o valor.
 */
export interface CredentialFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly helpText?: string;
}

export interface CredentialFormSpec {
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly CredentialFieldSpec[];
  readonly submitLabel?: string;
}

export interface CredentialSubmitContext extends ConnectContext {
  readonly values: Readonly<Record<string, string>>;
}

/** Contexto do passo de seleção: os valores já submetidos + o alvo escolhido. */
export interface ConnectSelectContext extends CredentialSubmitContext {
  readonly targetId: string;
}

/**
 * Estratégia de conexão de um provedor. O dialog é agnóstico; cada connector
 * implementa seu fluxo. Extensão desta fatia: `selectTarget` (passo de escolha de
 * alvo) — o registry base só modelava success/cancel/error.
 */
export interface ConnectorStrategy {
  readonly key: string;
  /** Quando presente, o dialog mostra um step de form antes de "connecting". */
  readonly credentialForm?: CredentialFormSpec;
  /** Texto do step "intro" (default genérico quando ausente). */
  readonly introHint?: string;
  /**
   * Garantias/avisos do provider exibidos como bullets no "intro" (ex: privacidade
   * do token). Ficam no connector — não no dialog — p/ o dialog seguir agnóstico.
   */
  readonly assurances?: readonly string[];
  /** Fluxo sem formulário (OAuth/embedded). Opcional — connectors credential-based não usam. */
  start?(ctx: ConnectContext): Observable<ConnectResult>;
  /** Chamado após o submit do form. Pode retornar `select` (escolher alvo) ou success/error. */
  submitCredentials?(ctx: CredentialSubmitContext): Observable<ConnectResult>;
  /** Chamado após o usuário escolher um alvo do passo `select`. Finaliza a conexão. */
  selectTarget?(ctx: ConnectSelectContext): Observable<ConnectResult>;
}
