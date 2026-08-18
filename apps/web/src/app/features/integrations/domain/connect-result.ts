/**
 * Resultado de um fluxo de conexão de provedor. Genérico e agnóstico de provider —
 * o connect-dialog só renderiza; cada connector produz estes valores.
 *
 * `select` é a extensão para provedores que, após validar a credencial, expõem uma
 * lista de alvos (ex: as contas de anúncio da Meta) para o usuário escolher um.
 */
export interface ConnectSuccess {
  readonly kind: 'success';
  readonly integrationId: string;
  /** Aviso opcional exibido mesmo no sucesso (o texto é do connector). */
  readonly notice?: string;
}

export interface ConnectCancelled {
  readonly kind: 'cancelled';
}

export interface ConnectError {
  readonly kind: 'error';
  readonly message: string;
  readonly recoverable: boolean;
}

/** Alvo selecionável num passo intermediário (ex: uma ad account). */
export interface SelectableTarget {
  readonly id: string;
  readonly label: string;
  readonly sublabel?: string;
}

export interface ConnectSelectable {
  readonly kind: 'select';
  readonly targets: readonly SelectableTarget[];
}

export type ConnectResult = ConnectSuccess | ConnectCancelled | ConnectError | ConnectSelectable;
