import type {
  AccessibleAccount,
  Action,
  AdEntity,
  Creative,
  EntityLevel,
  InsightRow,
} from "../types/index.js";

/** Referência opaca a uma conta já resolvida (token + accountId internos ao adapter). */
export interface AdAccountRef {
  readonly adAccountId: string;
  /** token já descriptografado — o adapter não acessa o vault. */
  readonly accessToken: string;
}

export interface InsightsQuery {
  readonly account: AdAccountRef;
  readonly level: EntityLevel;
  readonly window: string; // ex: "last_7d" | "2026-08-01..2026-08-15"
  readonly fields: readonly string[];
  readonly timeIncrement?: "1" | "7" | "all_days";
}

export interface MutationResult {
  readonly action: Action;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

export interface MutateOptions {
  /** dry-run (ensaio): lê o before + computa o after SEM escrever na plataforma. */
  readonly dryRun?: boolean;
}

/** Resultado de um restore (undo): estado atual antes de reverter → estado restaurado. */
export interface RestoreResult {
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

/**
 * Falha genérica da borda de ads — o adapter traduz o erro específico do provider
 * (ex: `MetaApiError`) para esta forma, e a casca mapeia p/ HTTP amigável **sem**
 * conhecer o provider. `invalid_credential` = token inválido; `not_accessible` =
 * o token não tem posse do recurso; `upstream` = provider indisponível.
 */
export type AdsPlatformErrorKind =
  | "invalid_credential"
  | "not_accessible"
  | "rate_limited"
  | "upstream";

export class AdsPlatformError extends Error {
  constructor(
    readonly kind: AdsPlatformErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AdsPlatformError";
  }
}

/**
 * Borda de plataforma de ads. Adapter MVP = Meta (Graph v26).
 * Amanhã Google/TikTok = novo adapter, zero mudança no core.
 * O adapter é responsável por rate-limit/governor, async insight jobs e batch.
 */
export interface AdsPlatformPort {
  listEntities(account: AdAccountRef, level: EntityLevel): Promise<AdEntity[]>;
  getInsights(query: InsightsQuery): Promise<InsightRow[]>;
  getCreatives(account: AdAccountRef, adIds: readonly string[]): Promise<Creative[]>;
  /** Aplica uma mutação idempotente; retorna before/after p/ rollback. `dryRun`
   *  (opcional) só simula (lê + computa o after, não escreve). */
  mutate(account: AdAccountRef, action: Action, opts?: MutateOptions): Promise<MutationResult>;
  /** Undo: reaplica o `before` (status + budget ABSOLUTOS) numa entidade. Reversível. */
  restoreEntityState(
    account: AdAccountRef,
    entityId: string,
    before: Readonly<Record<string, unknown>>,
  ): Promise<RestoreResult>;
  /** Lê o estado atual (status + budgets) de uma entidade — re-check fresco (drift). */
  readEntityState(account: AdAccountRef, entityId: string): Promise<Record<string, unknown>>;
  /**
   * Lista contas acessíveis pelo token (onboarding: cola token → escolhe).
   * Também **valida** o token — credencial inválida lança `AdsPlatformError`.
   */
  listAccessibleAccounts(accessToken: string): Promise<AccessibleAccount[]>;
  /**
   * Busca uma única conta pelo id (onboarding: confirmar a escolha). Lança se o
   * token não tem posse da conta — valida acesso sem re-baixar a lista inteira.
   */
  getAdAccount(accessToken: string, adAccountId: string): Promise<AccessibleAccount>;
}
