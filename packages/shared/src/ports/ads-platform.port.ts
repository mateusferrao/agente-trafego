import type {
  AccessibleAccount,
  Action,
  AdEntity,
  ConversionGoal,
  Creative,
  EntityLevel,
  InsightRow,
  TargetingSpec,
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

// ─── Criação/duplicação (Fatia 7) ────────────────────────────────────────

/** Entrada de duplicação (escala/clone). O adapter traduz p/ `/copies` (só a cópia — o
 *  override de budget é passo separado `setEntityBudget`, pra a saga ser retomável). */
export interface DuplicateEntityInput {
  readonly sourceLevel: EntityLevel;
  readonly sourceId: string;
  /** campanha destino (cópia de adset entra na mesma campanha do vencedor). */
  readonly destinationCampaignId?: string;
  /** nasce ACTIVE ou PAUSED. */
  readonly status: "active" | "paused";
  /** sufixo de nome ("cópia"/"escala") p/ distinguir do original. */
  readonly renameSuffix?: string;
}

/** Resultado da duplicação — id da cópia + filhos criados (idempotência/retomada). */
export interface DuplicateResult {
  readonly copiedId: string;
  readonly childIds: readonly string[];
}

// ─── Criar do zero (saga granular — a casca orquestra + persiste ids parciais) ───

export interface CreateCampaignInput {
  readonly name: string;
  readonly objectiveGoal: ConversionGoal;
  readonly specialAdCategories: readonly string[];
  readonly status: "active" | "paused";
}
export interface CreateAdSetInput {
  readonly campaignId: string;
  readonly name: string;
  readonly dailyBudgetMinor: number;
  readonly goal: ConversionGoal;
  readonly pixelId?: string;
  readonly targeting: TargetingSpec;
  readonly status: "active" | "paused";
}
export interface CreateAdCreativeInput {
  readonly name: string;
  readonly pageId: string;
  readonly imageHash?: string;
  readonly videoId?: string;
  readonly linkUrl?: string;
  readonly copy: {
    readonly primaryText: string;
    readonly headline: string;
    readonly description?: string;
    readonly cta?: string;
  };
}
export interface CreateAdInput {
  readonly adsetId: string;
  readonly creativeId: string;
  readonly name: string;
  readonly status: "active" | "paused";
}

/** Upload de mídia p/ a plataforma (Fatia 7). Imagem → hash; vídeo → id (async). */
export interface UploadMediaInput {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}
export interface VideoStatus {
  /** `ready` = pronto p/ usar em criativo; `processing` = ainda transcodificando; `error`. */
  readonly status: "ready" | "processing" | "error";
}

/** Defaults inferidos da conta p/ criar do zero (Page/Pixel/objetivo/mídia/link) — §6. */
export interface CreationDefaults {
  readonly pageId?: string;
  readonly pixelId?: string;
  readonly objectiveGoal?: ConversionGoal;
  readonly imageHash?: string;
  readonly linkUrl?: string;
  readonly sourceAdId?: string;
  /**
   * Vídeo do melhor anúncio reusável (quando o criativo escolhido é vídeo). Espelha
   * `imageHash` — a saga usa um OU outro conforme o formato do criativo campeão.
   */
  readonly videoId?: string;
  /**
   * Copy dos melhores anúncios veiculando (aterramento da geração — melhor primeiro).
   * O core nunca vê o firehose; só esta amostra curada do que já performa.
   */
  readonly winnerCopy?: ReadonlyArray<{ readonly primaryText?: string; readonly headline?: string }>;
  /**
   * Formato do anúncio #1 por desempenho quando ele NÃO é reusável hoje (`carousel`/`catalog`/
   * `other`) — a mídia devolvida é do melhor REUSÁVEL abaixo dele. A casca usa isto pra ser
   * transparente ("seu melhor é um carrossel, que ainda não sei clonar"). Neutro (sem PT).
   */
  readonly unsupportedTopFormat?: "carousel" | "catalog" | "other";
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
  // a entidade-fonte não pode ser duplicada COMO ESTÁ (ex: criativo com recurso descontinuado
  // pela plataforma) — neutro, qualquer provider pode ter esse caso. A casca oferece alternativas.
  | "not_duplicable"
  | "upstream";

export class AdsPlatformError extends Error {
  constructor(
    readonly kind: AdsPlatformErrorKind,
    message: string,
    /** Mensagem que a PLATAFORMA escreveu pro usuário final (neutro — qualquer provider pode
     *  ter uma). A casca prefere-a ao `message` técnico, envelopando ("A plataforma informou: …"
     *  + próximo passo). NUNCA carrega vocabulário específico do provider (ex: subcode Meta). */
    readonly userMessage?: string,
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
  /** Frames HD (URLs) de um vídeo por `video_id` — p/ a visão de criativo da biblioteca. */
  getVideoFrames(account: AdAccountRef, videoId: string): Promise<string[]>;
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
   * Duplica uma entidade (escala/clone) via `/copies` (Fatia 7). Opcionalmente ajusta o
   * budget da cópia (escala) e nasce ACTIVE/PAUSED. Retorna a cópia + filhos p/ retomada.
   */
  duplicateEntity(account: AdAccountRef, input: DuplicateEntityInput): Promise<DuplicateResult>;
  /** Define o budget diário absoluto de uma entidade (escala pós-cópia; idempotente). */
  setEntityBudget(account: AdAccountRef, entityId: string, dailyBudgetMinor: number): Promise<void>;
  /** Saga de criação do zero — granular (a casca persiste ids parciais p/ retomada idempotente). */
  createCampaign(account: AdAccountRef, input: CreateCampaignInput): Promise<{ campaignId: string }>;
  createAdSet(account: AdAccountRef, input: CreateAdSetInput): Promise<{ adsetId: string }>;
  createAdCreative(account: AdAccountRef, input: CreateAdCreativeInput): Promise<{ creativeId: string }>;
  createAd(account: AdAccountRef, input: CreateAdInput): Promise<{ adId: string }>;
  /** Infere Page/Pixel/objetivo/mídia/link do que a conta já usa (§6 — sem pages_show_list). */
  inferCreationDefaults(account: AdAccountRef): Promise<CreationDefaults>;
  /** Sobe imagem p/ a conta → `image_hash` estável (reusável em object_story_spec). */
  uploadImage(account: AdAccountRef, input: UploadMediaInput): Promise<{ imageHash: string }>;
  /** Sobe vídeo → `video_id` (processamento ASSÍNCRONO; checar getVideoStatus antes de usar). */
  uploadVideo(account: AdAccountRef, input: UploadMediaInput): Promise<{ videoId: string }>;
  /** Estado do processamento de um vídeo (ready|processing|error). */
  getVideoStatus(account: AdAccountRef, videoId: string): Promise<VideoStatus>;
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
