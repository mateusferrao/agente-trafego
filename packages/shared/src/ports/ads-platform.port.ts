import type {
  AccessibleAccount,
  AccountHealth,
  Action,
  ActivationTree,
  AdEntity,
  AdMetric,
  AudienceProfile,
  BreakdownDimension,
  BreakdownSegment,
  CampaignStructure,
  ConversionGoal,
  Creative,
  CustomAudience,
  DeliveryEstimate,
  EntityLevel,
  GeoSearchResult,
  InsightRow,
  InterestSearchResult,
  TargetingSpec,
  WhatsappDestination,
  PageInfo,
  PixelInfo,
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
  /** breakdowns da Graph API (ex: ["age","gender"]) — usado só por `getBreakdownInsights`
   *  internamente no adapter (S7); ausente no sync diário normal. */
  readonly breakdowns?: readonly string[];
}

/** Consulta de breakdown demográfico/posicionamento (S7, pivô saúde) — só conta+campanha
 *  (adset/ad é fast-follow). Sem `timeIncrement`: agregado da janela inteira (cadência
 *  própria, mais lenta — não precisa de granularidade diária). */
export interface BreakdownInsightsQuery {
  readonly account: AdAccountRef;
  readonly level: "account" | "campaign";
  readonly window: string;
  readonly dimension: BreakdownDimension;
}

/** Uma entidade com seu breakdown já agrupado por segmento (o adapter esconde o shape
 *  flat da resposta da plataforma — cada linha crua vira 1 segmento dentro da entidade).
 *  `resolvedAt`-style de CPA/ROAS fica a cargo do worker (o adapter não conhece a
 *  conversão de NEGÓCIO do agente) — `metrics` chega com escalares base + `conversions`
 *  cru p/ o worker resolver, mesmo padrão de `InsightRow`. */
export interface EntityBreakdownRow {
  readonly entityId: string;
  readonly level: EntityLevel;
  readonly segments: readonly BreakdownSegment[];
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

/** Resultado da duplicação — id da cópia + filhos criados (idempotência/retomada). `childIds`
 *  = ads copiados; `childAdsetIds` = adsets copiados INTERMEDIÁRIOS (só existem no deep_copy de
 *  CAMPANHA — precisam ser ativados junto, senão travam a entrega mesmo com campanha+ads ativos). */
/** Códigos de modernização conhecidos — fonte única (evita string mágica duplicada entre a
 *  tradução PT e a leitura defensiva). Adicionar um código = uma linha aqui + o case no core. */
export const MODERNIZATION_CODES = ["attribution_window_modernized", "budget_distributed_across_adsets"] as const;
export type ModernizationCode = (typeof MODERNIZATION_CODES)[number];

/** Diferença INEVITÁVEL que a reconstrução introduziu vs a fonte (a plataforma descontinuou o
 *  valor original, ex: janela de atribuição). Neutro — sem vocabulário do provider. O core
 *  traduz `code` → PT no desfecho. */
export interface ModernizationNote {
  readonly code: ModernizationCode;
}

/** Orçamento diário atual de um conjunto (unidade mínima da moeda). */
export interface AdsetBudgetRef {
  readonly id: string;
  readonly dailyMinor: number;
}
/** Modelo de orçamento de uma campanha: `campaignDailyMinor` presente = CBO (budget na campanha);
 *  `null` = ABO (budget nos conjuntos, em `adsets`). Neutro — sem vocabulário do provider. */
export interface CampaignBudgetLayout {
  readonly campaignDailyMinor: number | null;
  readonly adsets: readonly AdsetBudgetRef[];
}

export interface DuplicateResult {
  readonly copiedId: string;
  readonly childIds: readonly string[];
  readonly childAdsetIds: readonly string[];
  /** modernizações que a reconstrução precisou aplicar (vazio quando tudo veio de `/copies`). */
  readonly modernizations: readonly ModernizationNote[];
}

/** Entrada da estimativa de alcance (Fatia 7 — fast-follow): targeting NEUTRO + objetivo; o
 *  adapter monta o `targeting_spec` Meta (reusa a MESMA lógica do `createAdSet`) + o
 *  `optimization_goal` derivado do objetivo. `pixelId` afina o optimization_goal (conversão). */
export interface DeliveryEstimateInput {
  readonly targeting: TargetingSpec;
  readonly goal: ConversionGoal;
  readonly pixelId?: string;
}

// ─── Criar do zero (saga granular — a casca orquestra + persiste ids parciais) ───

export interface CreateCampaignInput {
  readonly name: string;
  readonly objectiveGoal: ConversionGoal;
  readonly specialAdCategories: readonly string[];
  readonly status: "active" | "paused";
  /**
   * CBO (Fatia 7 — cópia fiel): quando presente, o orçamento vive na CAMPANHA (bid_strategy +
   * budget_sharing na campanha) e o adset NÃO leva budget. Ausente = ABO (budget no adset).
   */
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
}
export interface CreateAdSetInput {
  readonly campaignId: string;
  readonly name: string;
  /** ABO: budget diário no adset. Ausente/0 = CBO (o orçamento está na campanha). */
  readonly dailyBudgetMinor?: number;
  readonly goal: ConversionGoal;
  readonly pixelId?: string;
  /** Page da conta — objeto promovido do conjunto (LEAD_GENERATION/CONVERSATIONS exigem;
   *  sem ela a Meta recusa anexar o anúncio: "conjunto sem objeto pra promover"). */
  readonly pageId?: string;
  readonly targeting: TargetingSpec;
  /** Advantage+ audience (C3): true = deixa a Meta EXPANDIR além do público escolhido; ausente/false
   *  = público fixo (comportamento pré-C3 no `explicit`). Só afeta o público EXPLÍCITO — `advantage_plus`
   *  já é amplo e `reuse_adset` herda a expansão da fonte. */
  readonly advantageAudience?: boolean;
  readonly status: "active" | "paused";
}
export interface CreateAdCreativeInput {
  readonly name: string;
  readonly pageId: string;
  /** objetivo da campanha — o criativo muda por ele: conversas no WhatsApp (messaging_started) exige
   *  CTA de WhatsApp + link genérico (não um CTA/link de site), senão a Meta recusa o criativo. */
  readonly goal: ConversionGoal;
  readonly imageHash?: string;
  readonly videoId?: string;
  readonly linkUrl?: string;
  readonly copy: {
    readonly primaryText: string;
    readonly headline: string;
    readonly description?: string;
    readonly cta?: string;
  };
  /** Advantage+ creative enhancements (C3): true = a Meta pode AJUSTAR AUTOMATICAMENTE imagem/texto
   *  do anúncio pra performar melhor (opt-in por feature; a Meta remove as inelegíveis). Ausente/false
   *  = criativo exatamente como aprovado. O eco AVISA quando ON (o entregue pode diferir do aprovado). */
  readonly advantageCreative?: boolean;
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
   * Adset do melhor anúncio reusável — permite herdar o PÚBLICO já provado (targeting
   * `reuse_adset`) em vez de cair em Advantage+ amplo, honrando travas de geo/audience que
   * o dono já tenha configurado manualmente naquele conjunto.
   */
  readonly sourceAdsetId?: string;
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
  /**
   * `opts.statusFilter: "active"` (S7-sync) pede à META, na ORIGEM, só entidades com
   * `effective_status=ACTIVE` — corta a paginação de conjunto/anúncio em contas com muito
   * histórico pausado/arquivado (achado real: conta com 139 campanhas cacheadas, só ~13
   * ativas — paginar tudo pra descartar depois é o que estoura o rate-limit no meio do
   * caminho e vira análise parcial). Sem `opts` = catálogo COMPLETO (todo status) — o chat
   * (get_campaign_status/list_campaigns/liveCampaignsNotCached) PRECISA disso pra
   * resolver nome→id de campanha PAUSADA (ex: "reativa a campanha X"); nunca filtrar esse
   * caminho. Filtrado NÃO usa o cache de catálogo (`MetaEntityCache`) — o catálogo completo
   * já é a fonte cacheada; um 2º resultado (menor) sob a MESMA chave (conta,nível)
   * contaminaria o cache que o chat depende ser completo.
   */
  listEntities(account: AdAccountRef, level: EntityLevel, opts?: { readonly statusFilter?: "active" }): Promise<AdEntity[]>;
  getInsights(query: InsightsQuery): Promise<InsightRow[]>;
  /** Breakdown demográfico/posicionamento (S7) — 1 entrada por entidade, segmentos já
   *  agrupados. Cadência própria (mais lenta que `getInsights`), chamado pela casca. */
  getBreakdownInsights(query: BreakdownInsightsQuery): Promise<EntityBreakdownRow[]>;
  getCreatives(account: AdAccountRef, adIds: readonly string[]): Promise<Creative[]>;
  /** Métrica CRUA por anúncio (gasto + resultados de negócio), SÍNCRONA (1 GET com `insights`
   *  inline, não o report job) — pra enriquecer a busca AO VIVO de criativos (ex: recomendar o
   *  melhor entre pausados, cujo histórico existe). `window` = `date_preset` da Meta ("maximum",
   *  "last_30d", …). Best-effort: falha → vazio. É desempenho BRUTO — sem o tier/qualidade do run. */
  getAdMetrics(account: AdAccountRef, window: string): Promise<AdMetric[]>;
  /** Frames HD (URLs) de um vídeo por `video_id` — p/ a visão de criativo da biblioteca. */
  getVideoFrames(account: AdAccountRef, videoId: string): Promise<string[]>;
  /** URL da imagem de um criativo a partir do seu `image_hash` — `GET /act_<id>/adimages?
   *  hashes=[hash]&fields=url`. Anúncios de imagem montados com `object_story_spec.link_data.
   *  image_hash` NÃO expõem `creative.image_url`; o hash é a fonte ESTÁVEL da miniatura (card do
   *  rascunho / picker "anúncios da conta"). Best-effort: hash inacessível/indisponível → null. */
  getImageUrlByHash(account: AdAccountRef, imageHash: string): Promise<string | null>;
  /**
   * Resolve o número de WhatsApp de DESTINO de uma campanha (Fatia 7), escopado à campanha:
   * CTA do criativo (`meta_cta`) → Página conectada (`meta_page`) → nome da campanha
   * (`campaign_name`) → `none`. Sempre rotula a origem; nunca atribui de outra entidade.
   */
  getWhatsappDestination(account: AdAccountRef, campaignId: string): Promise<WhatsappDestination>;
  /** Info de UMA Página pelo id (nome + WhatsApp conectado) — pra mostrar/confirmar o DESTINO de uma
   *  campanha de conversas NO RASCUNHO. O NOME vem do nó da Página e, se o token não tem a Página como
   *  ativo (403), das PÁGINAS DO NEGÓCIO (fallback confiável via `listPages`). `number` é best-effort:
   *  a Meta raramente expõe o `whatsapp_number` da Página (o número real mora no conjunto pós-criação). */
  getPageWhatsappInfo(account: AdAccountRef, pageId: string): Promise<PageInfo>;
  /** Páginas que a conta pode usar como destino (id + nome) — pra o dono ESCOLHER quando há N e pra
   *  resolver o nome de uma Página. Fonte: páginas do NEGÓCIO dono da conta (owned + client_pages),
   *  confiável. Sem negócio/acesso → lista vazia (honesto). `number` não vem daqui (best-effort só no nó). */
  listPages(account: AdAccountRef): Promise<PageInfo[]>;
  /** Pixels de rastreamento de conversões da conta (id + nome) — pra o dono ESCOLHER qual usar quando
   *  há N e pra nomear o inferido. Best-effort: sem acesso/pixel → lista vazia (honesto, o caller cai no
   *  pixel inferido/padrão). Fonte: `{account}/adspixels`. */
  listPixels(account: AdAccountRef): Promise<PixelInfo[]>;
  /** Lista os custom/saved audiences da conta (Fatia 7) — remarketing/exclusões reais. */
  listCustomAudiences(account: AdAccountRef): Promise<CustomAudience[]>;
  /** Busca geo (país/região/cidade) por texto — Fase 1 (subfatia 3), targeting explícito por
   *  primitivos. Query vazia ou sem match → array vazio (o caller decide pergunta/honesto). */
  searchGeo(account: AdAccountRef, query: string, locationTypes: readonly ("country" | "region" | "city" | "neighborhood")[]): Promise<GeoSearchResult[]>;
  /** Busca interesse por texto (Fase 2, subfatia 4) — `/search?type=adinterest`, busca livre no
   *  servidor. Query vazia → array vazio. */
  searchInterests(account: AdAccountRef, query: string): Promise<InterestSearchResult[]>;
  /** Busca comportamento (behavior) por texto (Slice 4) — a Meta NÃO tem busca no servidor pra
   *  behaviors (enumeração completa); o adapter cacheia a lista e filtra LOCAL. Mesma taxonomia
   *  neutra do interesse (`InterestSearchResult` = opção de direcionamento detalhado). Vazio → []. */
  searchBehaviors(account: AdAccountRef, query: string): Promise<InterestSearchResult[]>;
  /** Estima o alcance de um targeting COMBINADO (Fatia 7 — fast-follow), ao vivo no momento da
   *  proposta (depende do público/exclusões escolhidos → não cacheável no run). Best-effort:
   *  `ready:false` quando a plataforma ainda não estimou. */
  getDeliveryEstimate(account: AdAccountRef, input: DeliveryEstimateInput): Promise<DeliveryEstimate>;
  /** Estima o alcance de um adset EXISTENTE (teto de escala por audiência, Fase 4) — usa a
   *  config ATUAL do próprio adset (sem reconstruir targeting). Reativo: só chamado quando
   *  já há proposta de escalar aquela entidade neste run. */
  getDeliveryEstimateForAdSet(account: AdAccountRef, adsetId: string): Promise<DeliveryEstimate>;
  /** Lê a estrutura NEUTRA de uma campanha existente p/ cópia fiel (Fatia 7) — escopado. */
  readCampaignStructure(account: AdAccountRef, campaignId: string): Promise<CampaignStructure>;
  /** Lê os descendentes VIVOS + status EFETIVO de uma campanha (`level:"campaign"` → conjuntos+anúncios)
   *  ou conjunto (`level:"adset"` → anúncios) — base da ativação em cadeia (religar os pausados) e da
   *  entrega efetiva (existe anúncio ativo?). Escopado (nunca account-wide), status fresco. */
  readActivationTree(account: AdAccountRef, level: "campaign" | "adset", id: string): Promise<ActivationTree>;
  /** Lê o perfil de público de UM adset isolado (público/idade/expansão) — usado no PROPOSE pra
   *  resolver+ecoar o público real de reuse_adset ANTES da confirmação (P0.2/P1), sem esperar o
   *  fluxo de cópia completa. `null` quando o adset não existe/não é lível (o caller decide: bloquear
   *  em vez de herdar às cegas). */
  getAudienceProfile(account: AdAccountRef, adsetId: string): Promise<AudienceProfile | null>;
  /** Campanha-mãe de um adset + seu orçamento (diário E vitalício, minor) — p/ escalar vencedor
   *  sob CBO (orçamento na campanha, não no adset). `null` se a campanha não resolver. */
  getAdSetCampaignBudget(account: AdAccountRef, adsetId: string): Promise<{ campaignId: string; dailyBudgetMinor: number; lifetimeBudgetMinor: number } | null>;
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
  /** Lê SÓ o `targeting` cru atual de um adset — drift FINO do revert de `adjust_audience` (D4):
   *  detecta uma edição CONCORRENTE de público entre o apply e o revert. Separado de
   *  `readEntityState` (status+budget) p/ não pesar as leituras comuns nem regredir o revert de
   *  budget. `null` quando não há targeting lível. */
  readAdSetTargeting(account: AdAccountRef, adsetId: string): Promise<Record<string, unknown> | null>;
  /**
   * Duplica uma entidade (escala/clone) via `/copies` (Fatia 7). Opcionalmente ajusta o
   * budget da cópia (escala) e nasce ACTIVE/PAUSED. Retorna a cópia + filhos p/ retomada.
   */
  duplicateEntity(account: AdAccountRef, input: DuplicateEntityInput): Promise<DuplicateResult>;
  /** Define o budget diário absoluto de uma entidade (escala pós-cópia; idempotente). */
  setEntityBudget(account: AdAccountRef, entityId: string, dailyBudgetMinor: number): Promise<void>;
  /** Lê o modelo de orçamento de uma campanha (CBO = budget na campanha; ABO = nos conjuntos) —
   *  o caller decide ONDE aplicar o novo budget da duplicação (setar na campanha ABO liga CBO e
   *  a Meta recusa se os conjuntos têm metas diferentes). */
  getCampaignBudgetLayout(account: AdAccountRef, campaignId: string): Promise<CampaignBudgetLayout>;
  /** Saga de criação do zero — granular (a casca persiste ids parciais p/ retomada idempotente). */
  createCampaign(account: AdAccountRef, input: CreateCampaignInput): Promise<{ campaignId: string }>;
  /** DELETE best-effort de uma campanha — limpa a órfã do-zero quando a criação falha DETERMINÍSTICA
   *  (a saga do-zero não é atômica). `true` = apagou; `false` = a limpeza falhou (a órfã segue lá).
   *  NUNCA lança (a limpeza não pode mascarar o erro original). */
  deleteCampaign(account: AdAccountRef, campaignId: string): Promise<boolean>;
  /** `targetingFallback: true` = um `reuse_adset` foi pedido mas a fonte não estava disponível
   *  (caiu em Advantage+ amplo) — o caller usa isso pra avisar o dono, não fica silencioso. */
  createAdSet(account: AdAccountRef, input: CreateAdSetInput): Promise<{ adsetId: string; targetingFallback: boolean }>;
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
  /**
   * Saúde da conta NA PRÓPRIA META (status/saldo/gasto/pagamento) — chamada dedicada,
   * separada do listing de onboarding (campos diferentes, cadência diferente: 1x por
   * sync, não paginado). Nunca lança por status não-ativo (isso É o dado, não um erro).
   */
  getAccountHealth(account: AdAccountRef): Promise<AccountHealth>;
}
