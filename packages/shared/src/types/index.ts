// ─── Ids (branded strings) ───────────────────────────────────────────────
export type OrgId = string & { readonly __brand: "OrgId" };
export type AdAccountId = string & { readonly __brand: "AdAccountId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type RunId = string & { readonly __brand: "RunId" };
export type ContactId = string & { readonly __brand: "ContactId" };
export type ApprovalId = string & { readonly __brand: "ApprovalId" };
export type DraftId = string & { readonly __brand: "DraftId" };

// ─── Result (core usa isto; casca usa exceções) ──────────────────────────
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ─── Ads domain ──────────────────────────────────────────────────────────
export type EntityLevel = "account" | "campaign" | "adset" | "ad";
export type EntityStatus = "active" | "paused" | "deleted" | "archived";

/**
 * Nó da árvore de ativação. `status` = status PRÓPRIO/configurado do nó (o que decide se RELIGAR —
 * um filho já ativo no próprio nível não precisa de ação, mesmo que o pai pausado o deixe sem
 * entregar). `effectiveStatus` = status EFETIVO da Meta (reflete os pais + revisão) — decide se
 * ENTREGA (anúncio efetivamente ativo ⇒ cadeia toda ativa).
 */
export interface ActivationNode {
  readonly id: string;
  readonly name: string | null;
  readonly status: EntityStatus;
  readonly effectiveStatus: EntityStatus;
}
/**
 * Descendentes VIVOS de uma campanha/conjunto — base da ativação em cadeia (religar os pausados no
 * PRÓPRIO nível) + da entrega efetiva (existe anúncio efetivamente ativo?). Escopado na leitura
 * (campanha → conjuntos+anúncios; conjunto → anúncios). `truncated` = a página não trouxe todos
 * (campanha grande) → o caller avisa em vez de sub-ativar em silêncio.
 */
export interface ActivationTree {
  readonly adsets: readonly ActivationNode[];
  readonly ads: readonly (ActivationNode & { readonly adsetId: string })[];
  readonly truncated: boolean;
}

/**
 * Estratégia de lance NEUTRA (S2) — mapeia o enum `bid_strategy` da Meta (vocabulário
 * Meta fica só no adapter, `mapBidStrategy`). `lowest_cost` é o padrão esperado (sem
 * cap); os outros 3 são formas de CAP/meta explícita, só recomendáveis com dado
 * acumulado suficiente (ver `BID_STRATEGY_TEXT`, packages/core/src/analysis-knowledge).
 */
export const BID_STRATEGIES = ["lowest_cost", "bid_cap", "cost_cap", "min_roas"] as const;
export type BidStrategy = (typeof BID_STRATEGIES)[number];

export interface AdEntity {
  readonly id: string;
  readonly level: EntityLevel;
  readonly name: string;
  readonly status: EntityStatus;
  readonly parentId?: string;
  /** Id da campanha ancestral (ad e adset) — link direto p/ montar a árvore campanha→adset→ad
   *  sem two-hop. `parentId` continua sendo o pai imediato (adset p/ ad, campanha p/ adset). */
  readonly campaignId?: string;
  /** Id do adset ancestral (só p/ ad) — pai imediato explícito, complementa `campaignId`. */
  readonly adsetId?: string;
  readonly dailyBudget?: number;
  readonly lifetimeBudget?: number;
  /** Saldo restante do `lifetimeBudget` (P1.2) — a Meta já contabiliza (campo `budget_remaining`
   *  da Graph API); dá o sinal de teto de vitalício SEM precisar de pacing por data (start/stop_time)
   *  nem de uma query de gasto all-time. Só tem sentido junto de `lifetimeBudget` (budget diário
   *  não tem "restante" — reseta todo dia). */
  readonly budgetRemaining?: number;
  /** Objetivo próprio da entidade (o que ela otimiza) — base do CPA/ROAS + intenção p/ análise. */
  readonly objective?: EntityObjective;
  /** Perfil de público do adset (§Bloco 2) — presente só no nível adset, quando há targeting. */
  readonly audience?: AudienceProfile;
  /** Número de WhatsApp de destino do conjunto (CTWA — `promoted_object.whatsapp_phone_number`),
   *  só no nível adset. Fonte autoritativa do destino em campanha click-to-WhatsApp; o run cacheia
   *  em `ad_creatives` (por ad, via o adset) → chat DB-first sem GET ao vivo. */
  readonly whatsappNumber?: string;
  /**
   * Estratégia de lance (S2) — a Meta expõe `bid_strategy` na campanha (CBO) OU no adset
   * (ABO), nunca nos dois ao mesmo tempo pra uma mesma decisão de lance.
   */
  readonly bidStrategy?: BidStrategy;
  /** Cap/meta de lance (major currency), quando `bidStrategy` != 'lowest_cost'. */
  readonly bidCapMajor?: number;
}

/** Estágio do público: frio (prospecção) × quente (remarketing) × indeterminado. */
export type AudienceStage = "prospecting" | "remarketing" | "unknown";

/**
 * Perfil de público NEUTRO de um adset (§Bloco 2). Resumo curado do targeting da
 * plataforma — o core/prompt/UI só falam este tipo; o vocabulário Meta (custom
 * audiences, flexible_spec) fica isolado no adapter (`meta-audience-map`). Compacto
 * de propósito: não despeja o firehose de segmentação nem infla tokens.
 */
export interface AudienceProfile {
  /** frio (só amplo/interesses/lookalike) × quente (tem custom audience de inclusão não-lookalike). */
  readonly stage: AudienceStage;
  /** nº de custom/lookalike audiences de INCLUSÃO. */
  readonly customAudienceCount: number;
  /** nº de audiences EXCLUÍDAS (ex: excluir compradores = prospecção limpa). */
  readonly exclusionCount: number;
  /** países/regiões resumidos (ex: ["BR"]). */
  readonly geo?: readonly string[];
  /** regiões/cidades com `key` da Meta preservado (não só o nome) — necessário pra reconstruir um
   *  `geo_locations` válido ao herdar/editar (ex: remover 1 cidade sem reler a fonte). Países não
   *  entram aqui (usam o código ISO direto, sem `key`). */
  readonly geoEntries?: readonly { readonly key: string; readonly name: string; readonly kind: "city" | "region" }[];
  readonly ageMin?: number;
  readonly ageMax?: number;
  /** principais interesses/comportamentos (top-N nomes), quando houver — resumo p/ eco/UI. */
  readonly interests?: readonly string[];
  /** interesses/comportamentos COM id, agrupados (Slice 6) — necessário pra CÓPIA FIEL repassar o
   *  targeting da fonte sem reler (o resumo `interests` só tem nomes). Cada grupo = OR; grupos = AND. */
  readonly interestGroupRefs?: readonly (readonly { readonly id: string; readonly name: string }[])[];
  readonly behaviorGroupRefs?: readonly (readonly { readonly id: string; readonly name: string }[])[];
  /** ids dos públicos salvos (custom audiences) incluídos/excluídos na fonte (Slice 9 — cópia fiel de
   *  REMARKETING; sem isso a cópia reuse_adset virava prospecção fria). `customAudienceCount` acima é só
   *  contagem pro resumo; estes carregam os ids reais pro apply reemitir. */
  readonly customAudienceIncludeIds?: readonly string[];
  readonly customAudienceExcludeIds?: readonly string[];
  /** Expansão de público (3 flags Meta neutralizados: advantage_audience + targeting_relaxation_types
   *  custom_audience/lookalike) — `summary` pro eco/UI ("unknown" = a fonte não tinha NENHUM dos 3
   *  configurado; NÃO confundir com "off" — quem decide fechar por segurança é a camada de resolução,
   *  não esta leitura). Os 3 campos `raw` (ausentes quando a fonte não configurou aquele flag) alimentam
   *  `resolveExpansion` (packages/ads-meta) pra montar o snapshot herdado sem herdar expansão às cegas. */
  readonly expansion: {
    readonly summary: "off" | "on" | "unknown";
    readonly advantageAudience?: 0 | 1;
    readonly relaxCustomAudience?: 0 | 1;
    readonly relaxLookalike?: 0 | 1;
  };
}

export interface InsightMetrics {
  readonly spend: number;
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number;
  readonly cpc: number;
  readonly cpm: number;
  readonly frequency?: number;
  readonly conversions?: number;
  readonly cpa?: number;
  readonly roas?: number;
  /** Receita rastreada TOTAL (soma de todo `value` das conversões, ex.: compras) — surfaça
   *  o retorno mesmo quando o goal de negócio é conversa/lead (sem valor). Undefined = sem receita. */
  readonly revenue?: number;
  /** Alcance (pessoas ÚNICAS, S6) — NUNCA some entre dias (dedup); o adapter usa o valor do
   *  ÚLTIMO dia da janela como proxy (aproximação documentada, mesmo rigor do `deliveryEstimate`). */
  readonly reach?: number;
  /** Cliques no LINK do anúncio (S6) — subconjunto de `clicks` (que inclui engajamento genérico
   *  no post: like/coment/share). Distingue "clicou no link de verdade" de engajamento social. */
  readonly inlineLinkClicks?: number;
  /** Contagem de reproduções de vídeo que chegaram a 25% (S6, soma entre dias — evento discreto). */
  readonly videoP25WatchedCount?: number;
  /** Derivado (não vem da Meta): `videoP25WatchedCount / impressions * 100`, aproximação do
   *  "gancho segura a atenção nos primeiros segundos" (impressão ≈ tentativa de reprodução em
   *  anúncio de vídeo). Ausente quando não há reprodução de vídeo reportada. */
  readonly videoHookRetentionPct?: number;
  readonly [key: string]: number | undefined;
}

/** Classificação de ranking da Meta, neutralizada (S6) — o vocabulário original
 *  (`ABOVE_AVERAGE`/`BELOW_AVERAGE_35`/`BELOW_AVERAGE_20`/`BELOW_AVERAGE_10`/`UNKNOWN`)
 *  vive só no adapter; os 3 níveis de "abaixo da média" colapsam em `below_average`
 *  (o core só precisa saber SE está abaixo, não a granularidade do tier). */
export type PlatformQualityRating = "above_average" | "average" | "below_average" | "unknown";

/** Rankings de qualidade/engajamento/conversão que a própria Meta calcula por anúncio
 *  (S6, só disponível a partir de ~500 impressões) — opinião independente da plataforma,
 *  separada do `HealthSignal` já testado no dado da conta. */
export interface PlatformQualityRankings {
  readonly quality?: PlatformQualityRating;
  readonly engagement?: PlatformQualityRating;
  readonly conversion?: PlatformQualityRating;
}

export interface InsightRow {
  readonly entityId: string;
  readonly level: EntityLevel;
  readonly date?: string; // YYYY-MM-DD (ausente = agregado da janela)
  readonly metrics: InsightMetrics;
  /** Conversões normalizadas (genérico, agnóstico de plataforma) — preenchido pelo adapter. */
  readonly conversions?: ConversionBreakdown;
  /** Breakdown cru opaco (action_type→valor) p/ auditoria/re-derivação. Shape agnóstico. */
  readonly rawActions?: Readonly<Record<string, number>>;
  /** Funil neutro derivado do `rawActions` pela casca (adapter mapper) — não persistido. */
  readonly funnel?: FunnelBreakdown;
  /** Rankings de qualidade da Meta (S6) — fato do dia da linha, não some entre dias. */
  readonly qualityRankings?: PlatformQualityRankings;
}

/**
 * Forma persistida em `insights_snapshots.metrics_json` (jsonb): escalares +
 * conversões normalizadas + breakdown cru (fidelidade p/ re-derivar sem re-sync).
 */
export interface StoredInsightMetrics {
  readonly metrics: InsightMetrics;
  readonly conversions?: ConversionBreakdown;
  readonly rawActions?: Readonly<Record<string, number>>;
  readonly qualityRankings?: PlatformQualityRankings;
}

/** Formato do objeto Meta veiculado (imagem/vídeo/carrossel/catálogo/outro) — NÃO confundir com
 *  `CreativeVisionResult.format` (estilo visual inferido pela visão, ex: "UGC"/"antes-depois"). */
export type AdFormat = "image" | "video" | "carousel" | "catalog" | "other";

/** Métrica CRUA por anúncio (neutro, agnóstico de plataforma) — gasto + resultados de negócio
 *  (conversões de fundo/meio de funil). Usado pra ranquear/recomendar criativos buscados AO VIVO
 *  (ex: pausados). NÃO carrega tier/qualidade (isso é do run de análise). */
export interface AdMetric {
  readonly adId: string;
  /** gasto na moeda da conta (unidade MAIOR — ex: reais), da janela consultada. */
  readonly spend: number;
  /** contagem de resultados de negócio (conversões) na janela — proxy neutro. */
  readonly results: number;
}

export interface Creative {
  readonly id: string;
  readonly adId: string;
  readonly name?: string;
  readonly body?: string;
  readonly title?: string;
  readonly callToAction?: string;
  readonly imageUrl?: string;
  /** Formato do objeto Meta (imagem/vídeo/carrossel/catálogo) — S. */
  readonly adFormat?: AdFormat;
  /** hash estável da imagem (reusável em `object_story_spec.link_data.image_hash`) — permite
   *  reusar um anúncio de IMAGEM ao vivo na criação (Fatia 7, Slice 12). */
  readonly imageHash?: string;
  readonly thumbnailUrl?: string;
  readonly videoId?: string;
  /** Page do `object_story_spec` (Fatia 7) — p/ lookup do WhatsApp na Página + reuso na criação. */
  readonly pageId?: string;
  /**
   * Número de WhatsApp de destino resolvido do CTA do criativo (Fatia 7): o adapter
   * traversa o `object_story_spec…call_to_action.value` (vocabulário Meta só lá) e
   * extrai o telefone via `extractPhoneFromUrl` (core puro). Campo NEUTRO — a mesma
   * fonte alimenta o cache no run e o `getWhatsappDestination` ao vivo (sem divergir).
   */
  readonly whatsappNumber?: string;
  /**
   * Frames-pôster p/ a visão (Fatia 6c): imagem estática = 1; vídeo = N frames HD
   * espaçados (Meta `/{video_id}?fields=thumbnails`, 1080p) em vez do selo pequeno.
   * O resolver manda todos como conteúdo multimodal. Ordem = abertura → fim.
   */
  readonly posterFrames?: readonly string[];
}

// ─── Destino de WhatsApp (Fatia 7, genérico) ─────────────────────────────
// De onde veio o número (rótulo de honestidade): promoted_object do conjunto (destino CTWA REAL,
// autoritativo) → CTA do criativo (quando o número está no wa.me) → Página conectada → nome da
// campanha (convenção do cliente, pede confirmação) → nenhum.
export const WHATSAPP_SOURCES = ["meta_promoted_object", "meta_cta", "meta_page", "campaign_name", "none"] as const;
export type WhatsappSource = (typeof WHATSAPP_SOURCES)[number];

/** Número de WhatsApp de destino de uma campanha + a origem de onde foi resolvido. */
export interface WhatsappDestination {
  /** telefone só-dígitos (E.164 sem "+") ou null quando `source==="none"`. */
  readonly number: string | null;
  readonly source: WhatsappSource;
  /** nome da entidade de onde o número foi lido (quando `campaign_name`), p/ o eco. */
  readonly entityName?: string;
}

/** Página do Facebook (destino de uma campanha de conversas) — taxonomia neutra. `whatsappNumber`
 *  é o WhatsApp conectado à Página (só-dígitos), best-effort: a Meta frequentemente não expõe. */
export interface PageInfo {
  readonly pageId: string;
  readonly name?: string;
  readonly whatsappNumber?: string;
}

// ─── Público salvo / custom audience (Fatia 7, genérico) ──────────────────
/** Custom/saved audience da conta — taxonomia neutra (vocabulário Meta só no adapter). */
export interface CustomAudience {
  readonly id: string;
  readonly name: string;
  /** subtipo neutro do público (ex: "custom" | "lookalike" | "website" | "engagement"). */
  readonly subtype?: string;
  readonly approximateCount?: number;
  /** heurística de nome (`LOOKALIKE_HINTS`) — lookalike × retarget quente. */
  readonly isLookalike: boolean;
}

/**
 * Resultado de busca de geo (Fase 1, subfatia 3) — vocabulário Meta (`adgeolocation`) isolado no
 * adapter. `key` é o identificador a passar de volta pro `TargetingSpec.explicit.geo`.
 */
export interface GeoSearchResult {
  readonly key: string;
  readonly name: string;
  readonly kind: "country" | "region" | "city" | "neighborhood";
  /** país-mãe (cidades/regiões) — desambiguação quando o nome é homônimo entre países. */
  readonly countryCode?: string;
}

/**
 * Resultado de busca de interesse (Fase 2, subfatia 4) — vocabulário Meta (`adinterest`) isolado
 * no adapter. `id` é o identificador a passar de volta pro `TargetingSpec.explicit.interests`.
 */
export interface InterestSearchResult {
  readonly id: string;
  readonly name: string;
  /** tamanho aproximado de audiência (quando a Meta devolve) — informativo, NUNCA usado pra
   *  auto-escolher entre ambíguos (decisão do produto: sempre pergunta, nunca o de maior audiência). */
  readonly audienceSize?: number;
  /** categoria/caminho do interesse (quando a Meta devolve) — contexto pro dono escolher certo. */
  readonly path?: readonly string[];
}

/**
 * Estimativa de alcance/entrega de um targeting COMBINADO (Fatia 7 — fast-follow) — taxonomia
 * neutra (vocabulário Meta `estimate_dau`/`estimate_mau`/`delivery_estimate` só no adapter). É a
 * previsão de quantas pessoas o público proposto (includes − excludes + geo/idade) atinge; superior
 * ao `approximateCount` por-público (que ignora exclusões/combinação). `ready:false` = a plataforma
 * ainda não conseguiu estimar (público novo/lookalike) → o caller degrada pro sinal por-público.
 * A Meta (v26) devolve o alcance MENSAL como faixa (`monthlyReach*`, sinal principal); `dailyActiveUsers`
 * (o antigo `estimate_dau`) vem raro → fallback. Custom audiences pequenas/privadas voltam achatadas no
 * piso de 1000 (a plataforma esconde o tamanho real) → o caller trata como não-informativo.
 */
export interface DeliveryEstimate {
  readonly ready: boolean;
  /** faixa de alcance MENSAL (limite inferior/superior) — o que a Meta v26 devolve. */
  readonly monthlyReachMin?: number;
  readonly monthlyReachMax?: number;
  /** pessoas ativas/dia (antigo `estimate_dau`, raro) — fallback quando não há faixa mensal. */
  readonly dailyActiveUsers?: number;
}

// ─── Breakdown demográfico/posicionamento (S7, pivô saúde) ───────────────
// Vocabulário Meta (age/gender/publisher_platform/platform_position) fica só no
// adapter — o core/worker falam por `key`/`label` neutros. Só conta+campanha
// (adset/ad é fast-follow, ver ROADMAP). Cadência própria (mais lenta que o sync
// diário) — `asOf` é o carimbo de frescor explícito (nunca implica frescor do dia).
export type BreakdownDimension = "demographic" | "placement";

/** Um segmento do breakdown (ex: "35-44 · mulheres" ou "Instagram Stories") com suas
 *  métricas agregadas na janela usada pelo sync de breakdown (não diário). `metrics.cpa`
 *  só existe DEPOIS do worker resolver a conversão de negócio do agente (o adapter não
 *  conhece o objetivo); `conversions` cru fica p/ fidelidade de re-derivação (mesmo
 *  padrão de `StoredInsightMetrics`). */
export interface BreakdownSegment {
  readonly key: string;
  readonly label: string;
  readonly metrics: InsightMetrics;
  readonly conversions?: ConversionBreakdown;
}

/** Breakdown de UMA entidade (conta ou campanha) numa dimensão — o que o adapter
 *  devolve e o que fica persistido (upsert, só o mais recente por entidade+dimensão). */
export interface EntityBreakdown {
  readonly dimension: BreakdownDimension;
  readonly segments: readonly BreakdownSegment[];
  /** YYYY-MM-DD — quando este breakdown foi sincronizado (cadência própria, mais lenta). */
  readonly asOf: string;
}

// ─── Conversão (genérico, agnóstico de plataforma) ───────────────────────
// O vocabulário/mapeamento específico de cada plataforma (Meta action_type,
// optimization_goal, etc.) vive SÓ no adapter. O core e o restante do sistema
// falam esta taxonomia neutra — adicionar Google/TikTok = novo adapter mapeando
// pro mesmo enum, sem tocar no core.
// Tupla const = fonte única da taxonomia neutra (deriva o tipo E o zod em schemas).
export const CONVERSION_GOALS = [
  "purchase",
  "lead",
  "registration",
  "initiate_checkout",
  "add_to_cart",
  "view_content",
  "add_payment_info",
  "search",
  "contact",
  "subscribe",
  "start_trial",
  "submit_application",
  "messaging_started",
  "app_install",
  "custom",
] as const;

export type ConversionGoal = (typeof CONVERSION_GOALS)[number];

/** Objetivo default quando não há meta de negócio nem conversão dominante inferível (criação F7). */
export const DEFAULT_CONVERSION_GOAL: ConversionGoal = "purchase";

// ─── Postura de comunicação do agente (como ele FALA — não o que a análise decide) ──
// Três eixos ORTOGONAIS que governam a VOZ do agente em toda superfície de fala
// (push da análise, chat, pulso, narrativa do site) — nunca o output estruturado do
// analista. Tuplas const = fonte única (derivam o tipo E o zod em schemas). Enums
// neutros em inglês (padrão AutonomyLevel/AlertSensitivity); rótulos PT no catálogo (core).
/** Quão diretivo: apresenta opções × assume e lidera com a recomendação. */
export const DIRECTIVENESS_LEVELS = ["consultative", "balanced", "directive"] as const;
export type Directiveness = (typeof DIRECTIVENESS_LEVELS)[number];
/** Quanto traz: nº de recomendações que o agente lidera (mapeado a uma contagem no core). */
export const VOLUME_LEVELS = ["concise", "balanced", "comprehensive"] as const;
export type Volume = (typeof VOLUME_LEVELS)[number];
/** Quanto explica: vai direto (assume familiaridade) × explica o básico (ensina). */
export const DIDACTIC_DEPTH_LEVELS = ["direct", "balanced", "explanatory"] as const;
export type DidacticDepth = (typeof DIDACTIC_DEPTH_LEVELS)[number];
/** Preset de experiência do LEITOR — semeia os 3 eixos (null = definido pelo arquétipo). */
export const EXPERIENCE_LEVELS = ["beginner", "intermediate", "advanced"] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

/** Uma linha do breakdown de conversões (count + valor monetário p/ ROAS). */
export interface ConversionCount {
  readonly goal: ConversionGoal;
  /** Preenchido quando `goal === "custom"` — distingue conversões personalizadas entre si. */
  readonly customConversionId?: string;
  readonly count: number;
  readonly value?: number;
}

export type ConversionBreakdown = readonly ConversionCount[];

// ─── Funil (secundário, genérico) ────────────────────────────────────────
// Sinais de qualidade do lead (ICP messaging), distintos de conversão. Taxonomia
// NEUTRA — o mapeamento da plataforma (Meta action_type) vive só no adapter.
// Aberta: novo estágio = 1 entrada; nova plataforma = novo adapter pro mesmo enum.
export type FunnelStage =
  | "conversation_started"
  | "first_reply"
  | "depth_2"
  | "depth_3"
  | "depth_5"
  | "replied";

export interface FunnelCount {
  readonly stage: FunnelStage;
  readonly count: number;
}
export type FunnelBreakdown = readonly FunnelCount[];

/** Resumo curado do funil (contagens + taxas derivadas) — o que o brief expõe. */
export interface FunnelSummary {
  readonly counts: Partial<Record<FunnelStage, number>>;
  /** first_reply / conversation_started (qualidade da 1ª resposta). */
  readonly replyRate?: number;
  /** profundidade (depth_3 ou o mais fundo disponível) / conversation_started. */
  readonly depthRate?: number;
}

/**
 * O objetivo próprio de uma entidade (o que ela otimiza na plataforma). Define o
 * numerador de CPA/ROAS **e** carrega a intenção que conduz a análise do agente.
 */
export interface EntityObjective {
  readonly goal: ConversionGoal;
  /** Id da conversão personalizada (quando `goal === "custom"`). */
  readonly customConversionId?: string;
  /** Rótulo legível (ex: nome da conversão personalizada) — p/ o brief/LLM. */
  readonly label?: string;
  /** Janela de atribuição usada, registrada p/ comparabilidade (ex: "7d_click"). */
  readonly attributionWindow?: string;
}

/**
 * Conta de anúncio acessível por um token, no onboarding (colar token → listar →
 * escolher). `id` é o ad account id **sem** o prefixo `act_` (como persistimos em
 * `ad_accounts.ad_account_id`); o adapter adiciona o prefixo ao falar com a Graph.
 */
export interface AccessibleAccount {
  readonly id: string;
  readonly name: string;
  readonly currency?: string;
  readonly businessId?: string;
}

/**
 * Status de saúde da conta NA PRÓPRIA META (`account_status`), neutro — vocabulário
 * Meta (códigos numéricos) só existe dentro do adapter. Código não reconhecido pela
 * Meta (enum novo/indocumentado) → `"unknown"`, nunca inventa um valor (mesmo espírito
 * de `BID_STRATEGY_MAP`).
 */
export const META_ACCOUNT_HEALTH_STATUSES = [
  "active",
  "disabled",
  "unsettled",
  "pending_review",
  "pending_settlement",
  "grace_period",
  "pending_closure",
  "closed",
  "unknown",
] as const;
export type MetaAccountHealthStatus = (typeof META_ACCOUNT_HEALTH_STATUSES)[number];

/** Subconjunto "alertável" — exclui `active` (nunca é um problema, não faz sentido no
 *  checklist de config). Inclui `unknown` de propósito: um código novo/indocumentado
 *  da Meta é exatamente o tipo de coisa que vale avisar, não silenciar. */
export const ALERTABLE_ACCOUNT_HEALTH_STATUSES = [
  "disabled",
  "unsettled",
  "pending_review",
  "pending_settlement",
  "grace_period",
  "pending_closure",
  "closed",
  "unknown",
] as const satisfies readonly Exclude<MetaAccountHealthStatus, "active">[];

/** Copy PT-BR de cada status alertável — tom do resto do app (impacto + sem jargão,
 *  validado nesta sessão). Usada no checklist de config (site) e na mensagem do
 *  alerta imediato (worker). */
export const ACCOUNT_HEALTH_STATUS_LABELS: Readonly<Record<Exclude<MetaAccountHealthStatus, "active">, string>> = {
  disabled: "Conta desativada, parou de veicular anúncios",
  closed: "Conta encerrada",
  pending_closure: "Conta em processo de encerramento",
  unsettled: "Pagamento pendente",
  pending_settlement: "Cobrança pendente",
  grace_period: "Pagamento atrasado, conta em período de carência",
  pending_review: "Conta em revisão de segurança pela Meta",
  unknown: "Status não reconhecido (novo código da Meta)",
};

/**
 * Saúde da conta na própria Meta (status/saldo/gasto/pagamento) — DIFERENTE do nosso
 * lifecycle interno (`ad_accounts.status`) e do `token_status`. Vem de `GET
 * /act_{id}?fields=account_status,disable_reason,balance,amount_spent,spend_cap,
 * funding_source_details` (chamada dedicada, 1x por sync — ver `getAccountHealth`).
 */
export interface AccountHealth {
  readonly status: MetaAccountHealthStatus;
  /** motivo da desativação, neutro — presente só quando status != active. Código
   *  não reconhecido → "unknown_reason" (honesto, nunca inventa). */
  readonly disableReason?: string;
  /** saldo/gasto total, já em unidade MAIOR (reuso de `toMajorBudget`). Pra
   *  `funding_source_details.type !== STORED_BALANCE` (cartão/fatura), `balanceMajor`
   *  é valor acumulado-não-cobrado, não "saldo disponível" — ver `fundingType`. */
  readonly balanceMajor?: number;
  readonly amountSpentMajor?: number;
  /** ausente = SEM teto definido — a Meta usa `spend_cap: "0"` pra "sem teto"; nunca
   *  mapeado como "teto de R$ 0,00" (achado confirmado ao vivo contra conta real). */
  readonly spendCapMajor?: number;
  /** já vem legível da própria Meta (`funding_source_details.display_string`, ex:
   *  "VISA *0835") — nunca o número completo do cartão, a Meta já mascara. */
  readonly paymentMethodLabel?: string;
  /** `"stored_balance"` = pré-pago genuíno (balanceMajor É saldo disponível de
   *  verdade); qualquer outro valor (cartão/fatura/etc) = balanceMajor é valor
   *  acumulado-não-cobrado, não confiável como "saldo caindo". */
  readonly fundingType?: "stored_balance" | "other";
  /** ISO — carimbo de frescor (mesmo padrão de `get_campaign_status`). */
  readonly checkedAt: string;
}

// ─── Ações do agente ─────────────────────────────────────────────────────
export type ActionType =
  | "pause_entity"
  | "resume_entity"
  | "adjust_budget"
  | "set_status"
  | "adjust_audience"; // Fatia C: editar o público (targeting) de um adset existente

export type ActionSource = "playbook" | "llm";
export type RiskLevel = "low" | "medium" | "high";

/**
 * Códigos das ressalvas de ESCALA (fonte única do tipo + zod). Cada um é um sinal de risco
 * detectado por um passe puro nível-Action (packages/core/analysis-guards) sobre uma ação de
 * escalar/reativar. Adicionar um novo passe = 1 entrada aqui.
 */
export const RESSALVA_CODES = [
  "no_significance",
  "worsening_marginal_cpa",
  "audience_ceiling",
  "creative_fatigue",
  "unconfirmed_hypothesis",
] as const;
export type RessalvaCode = (typeof RESSALVA_CODES)[number];

/**
 * Ressalva de uma ação de escala: "dá pra fazer, mas há um sinal de risco — precisa do teu OK".
 * Anexada por passes PUROS nível-Action; **trava o auto-apply** (nunca aplica sozinha, nem em
 * act_full) mas mantém a ação APROVÁVEL (com a mensagem honesta). Nome distinto de `caveat`
 * (findings qualitativos, §13 nomenclatura no nível certo).
 */
export interface Ressalva {
  readonly code: RessalvaCode;
  /** mensagem honesta em linguagem de dono (o "porém" + a recomendação do Roy). */
  readonly message: string;
}

/**
 * Desfecho da APLICAÇÃO de uma aprovação (Fatia "depois", diz×faz): distingue o que de fato
 * aconteceu — `applied` (escrita real), `simulated` (modo ensaio — sem mexer), `noop` (já estava
 * no estado), `blocked` (barrado no re-check), `failed` (erro da Meta; a aprovação segue pendente).
 * Fonte única do tipo — persistido em `approvals.apply_outcome` e lido pelo card.
 */
export const APPLY_OUTCOMES = ["applied", "simulated", "noop", "blocked", "failed"] as const;
export type ApplyOutcome = (typeof APPLY_OUTCOMES)[number];

/**
 * Preview do que APROVAR faz (Fatia unificação): `real` (vale), `simulated` (ensaio — não altera),
 * `blocked` (não permitido/trava/conta indisponível). `message` = a linha honesta (voz do Roy) ou
 * null em `real`. Computado no servidor (`computeApplyPreview`, core) — fonte única; o front só renderiza.
 */
export type ApplyEffect = "real" | "simulated" | "blocked";
export interface ApplyPreview {
  readonly effect: ApplyEffect;
  readonly message: string | null;
}

export interface ActionTarget {
  readonly level: EntityLevel;
  readonly id: string;
  /** rótulo legível no momento da ação (display-only; playbook/LLM não preenchem — a casca enriquece antes de persistir). */
  readonly name?: string;
}

export interface Action {
  readonly id: string;
  readonly type: ActionType;
  readonly target: ActionTarget;
  readonly params: Readonly<Record<string, unknown>>; // ex: { mode:'decrease', pct:20 }
  readonly source: ActionSource;
  readonly riskLevel: RiskLevel;
  readonly reason: string;
  readonly confidence?: number; // 0..1 (ações do LLM)
  readonly ruleId?: string; // ações do playbook
  /** ressalvas de escala (Fatia A): sinais de risco que travam o auto-apply mas mantêm aprovável. */
  readonly ressalvas?: readonly Ressalva[];
}

/** Ação candidata antes de passar pelo guardrail. */
export type CandidateAction = Action;

export interface Finding {
  readonly title: string;
  readonly detail: string;
  readonly severity: "info" | "warning" | "critical";
}

/**
 * Estado de **aplicabilidade** de uma recomendação — se a ação proposta pode ser
 * aplicada pelo sistema agora. Conceito desacoplado: toda sugestão sem aplicação
 * possível compartilha o mesmo estado/comportamento (sem CTA de aplicar).
 *  - `applicable`        → o caminho de escrita existe (Fatia 5+); UI mostra o CTA.
 *  - `not_yet_applicable`→ read-only (3a/3b): só sugere; UI direciona ("em breve").
 */
export type RecommendationApplicability = "applicable" | "not_yet_applicable";

/**
 * Formato de uma recomendação — desacopla a recomendação da ação de plataforma
 * (a ação é OPCIONAL). Tupla const = fonte única (deriva tipo + zod), padrão de
 * `CONVERSION_GOALS`. Três formatos convivem:
 *  - `platform_action` → carrega uma capacidade executável do catálogo (pausar,
 *    ajustar budget, …); vira o caminho de eco+confirma/aprovação.
 *  - `human_direction` → direção clara que o HUMANO executa (direção de criativo/
 *    público, conselho de escalar/criar); nunca auto-aplica.
 *  - `insight`         → leitura estratégica em texto, sem ação atrelada.
 */
export const RECOMMENDATION_KINDS = ["platform_action", "human_direction", "insight"] as const;

export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

/**
 * Motivo da degradação graciosa de um run (por que virou "parcial") — deixa de ser
 * caixa-preta: o run registra QUAL chamada caiu, e a nota da UI fica proporcional.
 * `metrics`/`entities` = dado da análise incompleto (grave). `creative_vision`/
 * `campaign_analysis` = só enriquecimento (métricas intactas). `action_apply` = uma
 * escrita falhou (análise completa). Tupla const = fonte única (tipo + zod).
 */
export const PARTIAL_REASONS = [
  "metrics",
  "entities",
  "creative_vision",
  "campaign_analysis",
  "review",
  "action_apply",
] as const;

export type PartialReason = (typeof PARTIAL_REASONS)[number];

// ─── AccountBrief (único input do LLM) ───────────────────────────────────

/** Selo de confiança de um aprendizado (a UI traduz p/ rótulo acentuado). */
export type LessonConfidenceTier = "explorando" | "provavel" | "confirmado";
/** De onde veio o aprendizado — a UI mostra a proveniência ao usuário. */
export type LessonOrigin = "our_action" | "observational" | "human_feedback" | "human_manual";

/** Snapshot da config de uma entidade num dia (aprendizado, S4) — orçamento/status. */
export interface EntityConfigSnapshot {
  readonly status: EntityStatus;
  /** orçamento diário (unidade MENOR da moeda). */
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
}

/** Aprendizado pronto para o prompt do analista / cartão da UI (projeção legível). */
export interface BriefLesson {
  readonly content: string;
  readonly tier: LessonConfidenceTier;
  readonly origin: LessonOrigin;
}

export interface TrendPoint {
  readonly date: string;
  readonly metrics: Partial<InsightMetrics>;
}

/**
 * Base de medição do CPA/ROAS desta entidade vs a conversão de NEGÓCIO do agente:
 *  - `target` → a CPA/ROAS medida É a conversão que julgamos (meta aplicável).
 *  - `proxy`  → a conversão de negócio não é mensurável aqui (a entidade otimiza
 *               outra coisa); mostramos a métrica do objetivo da entidade como
 *               PROXY rotulado — nunca declaramos meta batida contra ela.
 *  - `none`   → sem conversão nenhuma → julga por CPC/CPM.
 */
export type ConversionBasis = "target" | "proxy" | "none";

/** Métrica-proxy (objetivo próprio da entidade) exibida quando o basis é `proxy`. */
export interface ConversionProxy {
  readonly goal: ConversionGoal;
  readonly customConversionId?: string;
  readonly cpa?: number;
  readonly roas?: number;
}

// ─── Qualidade da análise (Fatia 6c) ─────────────────────────────────────
// Camada determinística PURA sobre o dado curado (tiers, sinais de saúde,
// elegibilidade de decisão, referência de cold-start). O comparador nº1 continua
// sendo a meta do dono; isto é ranqueamento relativo + rede de segurança, nunca
// declara sucesso de negócio (só a meta faz isso).

/** Classe de desempenho relativa à meta + à conta. Rótulo amigável fica na UI. */
export type PerformanceTier = "winner" | "performer" | "underperformer" | "zombie";

/** Sinais de saúde nomeados (estende a detecção de anomalias com semântica de tráfego).
 *  `creative_fatigue`: desgaste (2+ sinais de deterioração) numa entidade que JÁ NÃO ENTREGA
 *  (não bate a meta / não é mais eficiente) — hora de renovar/trocar o criativo.
 *  `creative_aging`: os MESMOS sinais de desgaste, mas a entidade AINDA ENTREGA resultado (bate a
 *  meta / segue eficiente) — não é "troque já", é "prepare o sucessor e troque quando o resultado
 *  cair, não antes"; nunca matar/trocar um vencedor provado por um não-provado (§7 proteger winners).
 *  Ambos travam ESCALA/DUPLICAÇÃO igual (subir verba/duplicar num criativo desgastando queima verba),
 *  só a DIREÇÃO da recomendação difere.
 *  `weak_creative` (S4b): prova fraca + baixa densidade persuasiva (visão) — NUNCA vira
 *  critério de guard (é score de LLM, soft); só informa NOTE/matcher. `platform_quality_below_average`
 *  (S6): a própria Meta classifica o anúncio abaixo da média (qualidade/engajamento/conversão) —
 *  opinião independente da plataforma, mesma regra de NOTE-só. `weak_hook_retention` (S6): retenção
 *  de vídeo nos primeiros 25% baixa — métrica DURA (não score de LLM), mas ainda assim só informa
 *  NOTE/direção de criativo, nunca guard (é sinal de qualidade de criativo, não de economia da ação). */
export type HealthSignal =
  | "creative_fatigue"
  | "creative_aging"
  | "audience_saturation"
  | "low_volume"
  | "weak_creative"
  | "platform_quality_below_average"
  | "weak_hook_retention";

/**
 * Elegibilidade de DECISÃO da entidade — se dá pra concluir/agir sobre a conversão.
 * `hasSignificance` = dado suficiente (conversões de negócio OU cliques + dias);
 * `inLearning` = criada/editada há pouco (Meta re-otimizando). Guard usa os dois.
 */
export interface DecisionEligibility {
  readonly hasSignificance: boolean;
  readonly inLearning: boolean;
  /** conversões de negócio contadas na janela (p/ a nota do guard). */
  readonly conversions: number;
  readonly clicks: number;
}

export type BenchmarkCtrRating = "ruim" | "ok" | "bom" | "otimo";

/**
 * Referência de plataforma (cold-start apenas) — direcional, NUNCA a meta do dono.
 * `coldStart` liga o nudge "defina sua meta". Ausente quando há meta ou histórico.
 */
export interface BenchmarkRef {
  readonly coldStart: boolean;
  readonly ctrRating?: BenchmarkCtrRating;
  readonly frequencyAlert?: boolean;
  readonly costReference?: {
    readonly label: string;
    readonly min: number;
    readonly max: number;
    readonly currency: string;
  };
}

/** Grupos neutros de resultado p/ a faixa de custo de referência (fonte única do tipo + zod). */
export const OUTCOME_KINDS = ["conversation", "lead", "sale"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** Budget resolvido de uma entidade (P1.2 — sinal de teto de gasto p/ criação proativa). Unidade
 *  MAIOR da moeda (major), mesma convenção de `AdEntity.dailyBudget`/`lifetimeBudget`. */
export interface EntityBudget {
  readonly dailyMajor?: number;
  readonly lifetimeMajor?: number;
  /** só presente junto de `lifetimeMajor` — ver `AdEntity.budgetRemaining`. */
  readonly lifetimeRemainingMajor?: number;
}

export interface EntitySummary {
  readonly id: string;
  readonly level: EntityLevel;
  readonly name: string;
  readonly status: EntityStatus;
  readonly metrics: InsightMetrics;
  readonly deltaVsBaseline: Partial<InsightMetrics>;
  readonly flags: readonly string[];
  /** Objetivo da entidade — intenção que conduz a análise (o que "bom" significa aqui). */
  readonly objective?: EntityObjective;
  /** Campanha-mãe (só adset) — P1.2 agrega budget ABO por-campanha a partir daqui. */
  readonly campaignId?: string;
  /** Budget resolvido (P1.2) — CBO: da própria campanha; ABO: ausente aqui (agregado dos
   *  adsets filhos via `campaignId` em `attachBudgetCeiling`). */
  readonly budget?: EntityBudget;
  /** Sinal de teto de gasto (P1.2, só em campanhas) — `true` no teto, `false` com folga,
   *  ausente = sem dado de budget em lugar nenhum (nem próprio, nem dos adsets ABO). Tri-estado
   *  honesto: só `true` confirmado autoriza o AUTO-apply autônomo a duplicar/escalar sozinho. */
  readonly atBudgetCeiling?: boolean;
  /** Estratégia de lance (S2) — 'lowest_cost' é o padrão esperado; os demais só fazem sentido
   *  com dado acumulado suficiente (ver BID_STRATEGY_TEXT). */
  readonly bidStrategy?: BidStrategy;
  /** Cap/meta de lance (major currency), quando `bidStrategy` != 'lowest_cost'. */
  readonly bidCapMajor?: number;
  /** Perfil de público do adset (§Bloco 2) — estágio + resumo compacto do targeting. */
  readonly audience?: AudienceProfile;
  /** Base de medição vs a conversão de negócio do agente (§Fatia 4). */
  readonly conversionBasis?: ConversionBasis;
  /** Métrica-proxy do objetivo da entidade — presente só quando `conversionBasis === "proxy"`. */
  readonly proxy?: ConversionProxy;
  /** Funil de messaging da entidade (só quando há dado) — qualidade do lead. */
  readonly funnel?: FunnelSummary;
  /** Rankings de qualidade da Meta (S6) — só presente com dado real reportado pela plataforma. */
  readonly qualityRankings?: PlatformQualityRankings;
  /** Classe de desempenho relativa à meta + à conta (Fatia 6c). */
  readonly tier?: PerformanceTier;
  /** Sinais de saúde detectados (fadiga/saturação/baixo volume) — Fatia 6c. */
  readonly healthSignals?: readonly HealthSignal[];
  /** Elegibilidade de decisão (significância/learning) — insumo do guard (Fatia 6c). */
  readonly eligibility?: DecisionEligibility;
  /** Referência de plataforma no cold-start (sem meta e sem histórico) — Fatia 6c. */
  readonly benchmarkRef?: BenchmarkRef;
}

/**
 * Snapshot curado de UMA entidade (S1, pivô saúde) — projeção estável de `EntitySummary`
 * persistida em `entity_analyses.curated_json`, pra chat/UI/redator lerem sem reler o
 * brief inteiro do run (que não sobrevive além do run em memória). Builder puro em
 * `packages/core/src/curated-entity` (`buildCuratedEntitySnapshot`).
 */
export interface CuratedEntitySnapshot {
  /** Campanha-mãe (só adset, S8) — liga o diagnóstico do conjunto de volta à campanha ABO
   *  (a assimetria CBO×ABO precisa ser rotulável no chat: CLAUDE.md §13). */
  readonly campaignId?: string;
  readonly budget?: EntityBudget;
  readonly atBudgetCeiling?: boolean;
  /** true = orçamento na PRÓPRIA campanha (CBO); false = por conjunto/adset (ABO). */
  readonly isCBO: boolean;
  readonly tier?: PerformanceTier;
  readonly audience?: AudienceProfile;
  readonly funnel?: FunnelSummary;
  readonly conversionBasis?: ConversionBasis;
  readonly healthSignals?: readonly HealthSignal[];
  readonly eligibility?: DecisionEligibility;
  /** referência de plataforma no cold-start (S8) — direcional, nunca a meta do dono. */
  readonly benchmarkRef?: BenchmarkRef;
  /**
   * Sincronização (achado real): quando esta entidade estava no conjunto ATIVO da Meta
   * numa análise anterior e sumiu de lá (pausada/arquivada fora daqui — ex: direto no Ads
   * Manager), `record` marca a data da detecção aqui — ISO. Nunca sobrescrito enquanto
   * continuar ausente (preserva "desde quando"); some sozinho (rebuild do zero) se a
   * entidade voltar a ficar ativa e for reanalisada. `entity_analyses.metrics/tier/etc`
   * continuam sendo os da ÚLTIMA vez que ela esteve ativa — não confundir com dado atual.
   */
  readonly deactivatedSince?: string;
}

export interface Anomaly {
  readonly entityId: string;
  readonly metric: string;
  readonly zScore: number;
  readonly note: string;
}

// ─── CampaignUnit (unidade do map-reduce por campanha) ───────────────────────
// A campanha entregue ao LLM como árvore CURADA: adsets ativos + anúncios notáveis
// (top-N por gasto/flag) + cauda agregada por adset. Sobe a altitude do mapa de
// por-anúncio p/ por-campanha (menos calls, altitude acionável), sem cegar o LLM.

/** Cauda agregada de anúncios NÃO-notáveis de um adset (resumo, não firehose). */
export interface CampaignAdsetTail {
  readonly count: number;
  readonly spend: number;
  /** nenhum anúncio da cauda está flagado (fora da meta/anomalia) — resumo honesto. */
  readonly allWithinTarget: boolean;
}

/** Um adset dentro da campanha: seus anúncios notáveis (detalhe) + a cauda resumida. */
export interface CampaignAdsetGroup {
  readonly adset: EntitySummary;
  readonly notableAds: readonly EntitySummary[];
  readonly tail: CampaignAdsetTail;
}

/** Árvore curada de UMA campanha ativa — a unidade de análise do mapa por-campanha. */
export interface CampaignUnit {
  readonly campaign: EntitySummary;
  readonly adsets: readonly CampaignAdsetGroup[];
}

/**
 * Cartão por-campanha CONGELADO no run (snapshot em `agent_runs.metrics_snapshot`),
 * p/ o histórico exibir o recorte por campanha de análises antigas (o `entity_analyses`
 * é upsertado = só a última). `muted` NÃO entra (é estado dinâmico, resolvido na leitura).
 */
export interface RunCampaignCard {
  readonly externalId: string;
  readonly name: string | null;
  readonly metrics: {
    readonly spend: number;
    readonly ctr?: number;
    readonly cpa?: number;
    readonly roas?: number;
  };
  readonly summary: string | null;
  readonly topFinding: { readonly title: string; readonly severity: "info" | "warning" | "critical" } | null;
  readonly flags: readonly string[];
  /** tier de desempenho congelado no run (6c) — histórico coerente. */
  readonly tier?: PerformanceTier | null;
  /** sinais de saúde congelados no run — alimenta o aprendizado observacional (padrão
   *  recorrente de fadiga/saturação ao longo dos runs). Ausente = nenhum sinal. */
  readonly healthSignals?: readonly HealthSignal[];
  /** estágio de público DOMINANTE da campanha (§Bloco 2) — do adset de maior gasto. */
  readonly stage?: AudienceStage | null;
  /** orçamento congelado no run (S8) — mesmo campo de `CuratedEntitySnapshot`. */
  readonly budget?: EntityBudget;
  readonly atBudgetCeiling?: boolean;
  /** true = orçamento na PRÓPRIA campanha (CBO); false = por conjunto/adset (ABO). */
  readonly isCBO?: boolean;
}

export interface AgentGoals {
  readonly targetCPA?: number;
  readonly targetROAS?: number;
  /**
   * Conversão de NEGÓCIO do agente (Fatia 4) — o que conta como resultado pro dono
   * (ex: `purchase`). Vence o objetivo próprio da entidade no cálculo de CPA/ROAS
   * (`resolveConversion`). Ausente → usa o objetivo da entidade (zero-config).
   */
  readonly conversionGoal?: ConversionGoal;
  /** Id da conversão personalizada, quando `conversionGoal === "custom"`. */
  readonly customConversionId?: string;
}

/**
 * Saúde da MEDIÇÃO de conversão da conta (§Bloco 2). Sinaliza, de forma
 * determinística, que a atribuição de venda/lead parece incompleta — muito funil
 * (conversas) e pouquíssima conversão de negócio rastreada — p/ o agente não
 * decidir por CPA de venda enganoso. Hipótese, nunca veredito.
 */
export interface TrackingHealth {
  readonly suspect: boolean;
  /** conversas (conversation_started) agregadas da conta. */
  readonly funnelStarted: number;
  /** conversões de negócio RASTREADAS agregadas (meta do agente). */
  readonly trackedConversions: number;
  /** razão conversas / max(conversões,1) — quanto maior, mais suspeita a medição. */
  readonly ratio: number;
}

/** Um item do Pareto de gasto × resultado (§Bloco 2). */
export interface WasteParetoItem {
  readonly id: string;
  readonly name: string;
  readonly spend: number;
  /** % do gasto DO GRUPO (mesma base de conversão). */
  readonly spendPct: number;
  /** resultado do grupo (vendas/conversas/cliques conforme a base), quando derivável. */
  readonly result?: number;
  readonly resultPct?: number;
}

/**
 * Concentração 80/20 dentro de UM grupo de mesma base de conversão (§Bloco 2) —
 * nunca soma "conversa" com "venda". Grupo dominante = o de maior gasto.
 */
export interface WastePareto {
  readonly basis: ConversionBasis;
  readonly groupSpend: number;
  /** entidades do grupo, maior gasto primeiro (com % de gasto × % de resultado). */
  readonly items: readonly WasteParetoItem[];
  /** má alocação: gasto alto e resultado desproporcionalmente baixo. */
  readonly misallocated: readonly WasteParetoItem[];
}

/**
 * Quantificação de desperdício (§Bloco 2) — o "money shot" da auditoria. Números
 * de dinheiro determinísticos sobre o dado curado: quanto está sendo queimado
 * (zumbis) e onde o gasto está mal alocado (Pareto por base). Computado sobre o
 * conjunto COMPLETO de campanhas (não o brief podado), anexado ao AccountBrief.
 */
export interface WasteReport {
  readonly totalSpend: number;
  /** Σ gasto dos zumbis (campanhas com gasto relevante e zero sinal de vida). */
  readonly wastedSpend: number;
  readonly wastedPct: number;
  /** zumbis (id/nome/gasto) — p/ UI e p/ o impacto liberado por recomendação de pausa. */
  readonly zombies: readonly { readonly id: string; readonly name: string; readonly spend: number }[];
  readonly pareto?: WastePareto;
}

export interface AccountBrief {
  readonly account: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
    readonly window: string;
    readonly baselineWindow: string;
  };
  readonly goals: AgentGoals;
  readonly totals: InsightMetrics & { readonly delta: Partial<InsightMetrics> };
  readonly trends: readonly TrendPoint[];
  readonly segments: {
    readonly campaigns: readonly EntitySummary[];
    readonly adsets: readonly EntitySummary[];
    readonly ads: readonly EntitySummary[];
  };
  readonly anomalies: readonly Anomaly[];
  /** Funil de messaging agregado da conta (secundário; qualidade do lead do ICP). */
  readonly funnel?: FunnelSummary;
  /** Saúde da medição de conversão (§Bloco 2) — presente só quando suspeita. */
  readonly trackingHealth?: TrackingHealth;
  /** Desperdício + concentração 80/20 (§Bloco 2) — o "money shot". */
  readonly waste?: WasteReport;
  /** Breakdown demográfico da conta (S7) — só presente quando o spread é MATERIAL
   *  (`hasMaterialSpread`, gate de relevância). `asOf` nunca implica frescor do dia
   *  (cadência própria, mais lenta). */
  readonly demographics?: EntityBreakdown;
  /** Breakdown de posicionamento da conta (S7) — mesma regra de materialidade. */
  readonly placements?: EntityBreakdown;
  readonly creatives: readonly Creative[]; // só flagados (com imagem p/ visão)
  readonly playbookCandidates: readonly CandidateAction[];
  readonly memory: {
    readonly objectives: readonly string[];
    readonly pastActions: readonly string[];
    readonly rejected: readonly string[];
    /** Aprendizados curados desta conta (confirmados/alta confiança), rotulados —
     *  o analista trata como CONTEXTO, não como número a verificar. Ausente = sem lição. */
    readonly lessons?: readonly BriefLesson[];
  };
  readonly aggregatesRest: {
    readonly count: number;
    readonly spend: number;
    readonly avgCpa?: number;
  };
}

// ─── Playbook (regra determinística) ─────────────────────────────────────
export interface PlaybookCondition {
  readonly metric: keyof InsightMetrics | string;
  readonly op: ">" | "<" | ">=" | "<=" | "==";
  readonly value: number;
  readonly window: "3d" | "7d" | "14d";
  readonly minSpend?: number;
}

export interface PlaybookRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly scope: Exclude<EntityLevel, "account">;
  readonly when: PlaybookCondition;
  readonly then: { readonly type: ActionType } & Record<string, unknown>;
}

// ─── Guardrails ──────────────────────────────────────────────────────────
export interface GuardrailConfig {
  readonly maxBudgetChangePct: number;
  readonly maxEntitiesPerDay: number;
  readonly allowedActions: readonly ActionType[];
  readonly dryRun: boolean;
  readonly killSwitch: boolean;
  readonly llmCostCapUsd?: number;
  // ─── Limites de GASTO NOVO (Fatia 7 — criação) ───
  /** teto do budget diário (unidade mínima) de uma campanha/entidade NOVA. */
  readonly maxNewDailyBudgetMinor?: number;
  /** nº máx. de campanhas novas criadas por dia. */
  readonly maxNewCampaignsPerDay?: number;
  /** passo de escala (%) ao subir budget do vencedor / duplicar. */
  readonly scalePct?: number;
}

// ─── Criação de campanhas (Fatia 7) ──────────────────────────────────────
// Contrato NEUTRO — o vocabulário Meta (ODAX, object_story_spec, call_to_action_type,
// targeting) fica isolado no adapter (`meta-conversion-map`). Trocar de plataforma =
// novo adapter mapeando este mesmo contrato.

export const DRAFT_KINDS = ["from_scratch", "duplicate"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

// ─── Estratégia de fonte do criativo na criação (config por-agente, Fatia 7 Slice 10) ──
// De onde o agente tira o criativo pra uma campanha nova: reusar um que já veicula, escolher
// na biblioteca, ou o pool único (ambos). Vocabulário NEUTRO (nada de Meta).
export const CREATIVE_SOURCE_MODES = ["serving", "library", "both"] as const;
export type CreativeSourceMode = (typeof CREATIVE_SOURCE_MODES)[number];
/** sub-opção do modo `serving`: determinístico (melhor desempenho) OU o LLM escolhe por encaixe. */
export const SERVING_PICKS = ["best_performing", "agent"] as const;
export type ServingPick = (typeof SERVING_PICKS)[number];
export interface CreativeSourceStrategy {
  readonly mode: CreativeSourceMode;
  readonly servingPick?: ServingPick;
}
/** Default = comportamento de hoje (reusa o melhor veiculando, determinístico, sem LLM). */
export const DEFAULT_CREATIVE_SOURCE_STRATEGY: CreativeSourceStrategy = { mode: "serving", servingPick: "best_performing" };

export const CREATION_OPPORTUNITY_KINDS = [
  "scale_winner",
  "remarketing",
  "replicate_winner",
  "prospecting_expansion",
  "refresh_fatigued",
  "cold_start",
] as const;
export type CreationOpportunityKind = (typeof CREATION_OPPORTUNITY_KINDS)[number];

export const CREATIVE_FORMATS = ["image", "video"] as const;
export type CreativeFormat = (typeof CREATIVE_FORMATS)[number];

/** CTA neutro; o adapter mapeia p/ `call_to_action_type` da plataforma. */
export const CTA_TYPES = [
  "shop_now",
  "learn_more",
  "sign_up",
  "subscribe",
  "contact_us",
  "book_now",
  "get_offer",
  "send_message",
  "download",
] as const;
export type CtaType = (typeof CTA_TYPES)[number];

/** Uma variação de copy = um anúncio (1:1). */
export interface CopyVariant {
  readonly primaryText: string;
  readonly headline: string;
  readonly description?: string;
  readonly cta?: CtaType;
  /** nome do anúncio desta variação (a variação É o anúncio, 1:1). Ausente → derivado no apply. */
  readonly adName?: string;
  /** criativo PRÓPRIO deste anúncio (Fatia 7 — criativo por anúncio). Ausente → usa o criativo
   *  padrão do rascunho (`CampaignDraftSpec.creative`), preservando o comportamento antigo. */
  readonly creative?: CreativeAssetRef;
}

/** Referência a um asset da biblioteca de criativos (mídia já existente). */
export interface CreativeAssetRef {
  readonly assetId: string;
  readonly format: CreativeFormat;
  readonly origin: "reuse" | "upload";
  /** ids da plataforma resolvidos (quando já subidos). */
  readonly metaImageHash?: string;
  readonly metaVideoId?: string;
}

/**
 * Público/idade/expansão RESOLVIDOS de uma fonte, no momento do PROPOSE — gravado no rascunho
 * pra o eco mostrar o público real (P0.2) e o APPLY reusar sem reler a Meta (P1, mata a corrida
 * "fonte some entre eco e confirmação"). Shape PRÓPRIO e neutro — não importa `RawTargeting` do
 * adapter (`packages/ads-meta`); `shared` não pode depender de um adapter.
 */
/** Unidade de distância do raio de geo (Slice 7 — vocabulário neutro; o adapter mapeia p/ a Meta). */
export type DistanceUnit = "mile" | "kilometer";

export interface ResolvedAudienceSnapshot {
  readonly geo: {
    readonly countries?: readonly string[];
    readonly regions?: readonly { readonly key: string; readonly name: string }[];
    readonly cities?: readonly { readonly key: string; readonly name: string }[];
  };
  readonly ageMin?: number;
  readonly ageMax?: number;
  /** interesses/comportamentos da fonte COM id (Slice 6) — pra a cópia `reuse_adset` preservar o
   *  targeting detalhado no apply (senão o snapshot só tinha geo/idade/expansão e perdia interesses). */
  readonly interestGroups?: readonly (readonly { readonly id: string; readonly name: string }[])[];
  readonly behaviorGroups?: readonly (readonly { readonly id: string; readonly name: string }[])[];
  /** públicos salvos incluídos/excluídos na fonte (Slice 9) — a cópia reuse_adset de REMARKETING
   *  precisa reemitir; sem isso virava prospecção fria (bug de fidelidade + gasto no público errado). */
  readonly customAudienceIncludeIds?: readonly string[];
  readonly customAudienceExcludeIds?: readonly string[];
  /** decidido por `resolveExpansion` (packages/ads-meta) — ausente na fonte já vira 0 explícito
   *  aqui, nunca chega "ausente" neste snapshot (P1: nunca herda expansão às cegas). */
  readonly expansionRaw: { readonly advantageAudience: 0 | 1; readonly relaxCustomAudience: 0 | 1; readonly relaxLookalike: 0 | 1 };
}

/**
 * Targeting NEUTRO do rascunho: reusar o público provado de um adset (`reuse_adset`), amplo
 * (`advantage_plus`) ou EXPLÍCITO por primitivos (`explicit`). O kind `custom_audiences` foi
 * COLAPSADO em `explicit` (Fatia 7 — públicos salvos entram como `customAudienceInclude/ExcludeIds`;
 * a base geo/idade da fonte vira chips na cópia) — uma representação só.
 */
export type TargetingSpec =
  | {
      readonly kind: "reuse_adset";
      readonly sourceAdsetId: string;
      /** snapshot resolvido no propose — o `reuse_adset` SEMPRE nasce com retrato (Bug 3, Slice 0);
       *  ausente só em rascunho LEGADO (apply normaliza a expansão, nunca lê AS-IS). */
      readonly resolved?: ResolvedAudienceSnapshot;
    }
  | { readonly kind: "advantage_plus" }
  /**
   * Público EXPLÍCITO por primitivos (Fatia 7). Expansão SEMPRE fechada (público escolhido pelo dono —
   * sem ambiguidade de "fonte não decidiu", diferente de `reuse_adset`). Kind SUPERSET: geo/idade/
   * gênero/interesses + público salvo (`customAudienceInclude/ExcludeIds`) compõem no MESMO targeting.
   * Na CÓPIA, a geo/idade da fonte é reconstruída em `geo`/`ageMin`/`ageMax` (chips editáveis).
   * Vocabulário Meta fica no adapter.
   */
  | {
      readonly kind: "explicit";
      /** geo por primitivo. `radius`/`distanceUnit` (Slice 5) só valem p/ CITY (a Meta aceita raio só
       *  em `cities` + `custom_locations`; region/country ignoram → o adapter faz strip). 17–80 km.
       *  Ausente = a cidade inteira. Raio em torno de endereço = `radiusAreas` abaixo. */
      readonly geo: readonly {
        readonly key: string;
        readonly name: string;
        readonly kind: "country" | "region" | "city" | "neighborhood";
        readonly radius?: number;
        readonly distanceUnit?: DistanceUnit;
      }[];
      /** raio em torno de um ENDEREÇO (Slice 5) — a Meta geocodifica `address` no servidor (sem
       *  provedor externo). Raio 1–80 km. Nome neutro (`custom_locations` fica no adapter). */
      readonly radiusAreas?: readonly { readonly address: string; readonly radius: number; readonly distanceUnit: DistanceUnit }[];
      readonly ageMin?: number;
      readonly ageMax?: number;
      /** 1 = homens, 2 = mulheres — ausente/vazio = todos. */
      readonly genders?: readonly (1 | 2)[];
      readonly customAudienceIncludeIds?: readonly string[];
      readonly customAudienceExcludeIds?: readonly string[];
      /** interesses em GRUPOS (Slice 3): cada grupo = OR interno; grupos entre si = AND (narrowing).
       *  A Meta realiza via múltiplos objetos em `flexible_spec`. 1 grupo = comportamento antigo. */
      readonly interestGroups?: readonly (readonly { readonly id: string; readonly name: string }[])[];
      /** comportamentos (behaviors) em GRUPOS (Slice 4) — mesmo modelo dos interesses (cada grupo é
       *  um objeto próprio no `flexible_spec` → AND com os demais). Exclusão não existe (Meta removeu). */
      readonly behaviorGroups?: readonly (readonly { readonly id: string; readonly name: string }[])[];
    };

/**
 * Estrutura proposta da campanha — NEUTRA + VERSIONADA (validada nas bordas por zod,
 * com refine por `kind`). Campos comuns são obrigatórios; os de `from_scratch`
 * (objetivo/targeting/copy/criativo/página/pixel) são opcionais — no `duplicate` a
 * estrutura é herdada do source via `/copies`, só o budget/ativação variam.
 */
export interface CampaignDraftSpec {
  readonly version: 1;
  readonly currency: string;
  /** budget diário proposto (unidade mínima). */
  readonly dailyBudgetMinor: number;
  /** budget PEDIDO antes do clamp pelo teto de gasto novo — só quando cortado (`dailyBudgetMinor`
   *  ficou abaixo do pedido). Transparência §8: o eco/card mostram "pedi X, virou Y". */
  readonly requestedDailyBudgetMinor?: number;
  /** nasce ACTIVE ou PAUSED (activationPolicy do agente / override no eco). */
  readonly activation: "active" | "paused";
  // ─── só `from_scratch` (herdados no `duplicate`) ───
  /** conversão de negócio → o adapter deriva o objetivo ODAX. */
  readonly objective?: ConversionGoal;
  readonly targeting?: TargetingSpec;
  /** nº de anúncios do adset (= nº de variações de copy; cada uma vira 1 anúncio). */
  readonly variantsCount?: number;
  readonly copyVariants?: readonly CopyVariant[];
  /** criativo PADRÃO do rascunho — usado por qualquer anúncio sem criativo próprio
   *  (`CopyVariant.creative`). Continua sendo a mídia única quando ninguém sobrescreve. */
  readonly creative?: CreativeAssetRef;
  /** Page/Pixel inferidos (display/confirmação no eco). */
  readonly pageId?: string;
  readonly pixelId?: string;
  /** URL de destino do anúncio (link_data.link) — inferida da conta. */
  readonly linkUrl?: string;
  // ─── cópia fiel de campanha (Fatia 7, kind `copy`) ───
  /** campanha-base copiada (leitura fiel escopada, NÃO account-wide). */
  readonly sourceCampaignId?: string;
  /** nome proposto da campanha (preserva a convenção do cliente; fallback derivado no apply). */
  readonly name?: string;
  /** categorias especiais herdadas da fonte (habitação/emprego/crédito) — Meta exige preservar. */
  readonly specialAdCategories?: readonly string[];
  /** otimização de orçamento herdada da fonte (CBO = na campanha; ABO = no adset). */
  readonly budgetMode?: BudgetMode;
  /**
   * Criativos da fonte REUSADOS por referência (`creative_id` da Meta) — 1 anúncio por
   * ref, preservando `object_story_spec`/destino WhatsApp sem rebuild. Vazio → usa
   * `creative`+`copyVariants` (criar-do-zero). `copy`+refs = cópia fiel dos N anúncios.
   */
  readonly creativeRefs?: readonly string[];
  // ─── edição (Fatia 7 — nome editável no site/chat) ───
  /** nome editável da campanha / do conjunto (Fatia 7 — edição). Ausente → derivado no apply. */
  readonly campaignName?: string;
  readonly adsetName?: string;
  // ─── só `duplicate` (escala) ───
  /** rótulo do sufixo aplicado ao nome do vencedor no `/copies` (`<vencedor> — <rótulo>`).
   *  Ausente → "escala". NÃO é o nome inteiro (o `/copies` só ANEXA). */
  readonly suffixLabel?: string;
}

/** Otimização de orçamento (neutro): campanha (CBO) × conjunto (ABO). Tupla = fonte única do
 *  tipo + do enum zod (§13, mesmo padrão de CONVERSION_GOALS). */
export const BUDGET_MODES = ["cbo", "abo"] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];

/**
 * Estrutura NEUTRA lida de uma campanha existente p/ cópia fiel (Fatia 7). Só o adapter
 * conhece o vocabulário Meta (ODAX/optimization_goal/promoted_object); aqui é taxonomia
 * neutra. `readCampaignStructure` popula; o draft de cópia deriva daqui + overrides do dono.
 */
export interface CampaignStructure {
  readonly campaignId: string;
  readonly name: string;
  readonly budgetMode: BudgetMode;
  /** budget da fonte na unidade mínima (na campanha se CBO, no adset se ABO). */
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
  readonly objective: ConversionGoal;
  readonly specialAdCategories: readonly string[];
  /** pixel do promoted_object da fonte (Fatia 7) — sem ele, copiar campanha de conversão
   *  falha no createAdSet (OFFSITE_CONVERSIONS sem promoted_object). Ausente em mensagens. */
  readonly pixelId?: string;
  /** conjunto representativo (a cópia é 1-1-N): id + targeting neutro + destino WhatsApp. */
  readonly sourceAdsetId: string;
  readonly targeting: AudienceProfile;
  /** destino de WhatsApp do conjunto/criativo (quando a base otimiza mensagens). */
  readonly whatsappDestination?: WhatsappDestination;
  /** `creative_id`s dos anúncios ativos da campanha — reusados por referência na cópia. */
  readonly creativeRefs: readonly string[];
}

/** Entidade-origem de uma duplicação (o que foi copiado). `name` = rótulo legível do vencedor
 *  (pro card mostrar "Duplicar conjunto <nome>" em vez do id cru); ausente em rascunhos antigos. */
export interface DraftSourceRef {
  readonly level: EntityLevel;
  readonly id: string;
  readonly name?: string;
}

/** Rascunho de campanha (domínio) — `from_scratch` ou `duplicate`. */
export interface CampaignDraft {
  readonly kind: DraftKind;
  readonly spec: CampaignDraftSpec;
  readonly sourceRef?: DraftSourceRef;
}

/** Oportunidade de criação detectada (determinística) — semeia o proativo (Fatia 7). */
export interface CreationOpportunity {
  readonly kind: CreationOpportunityKind;
  readonly entityLevel?: EntityLevel;
  readonly entityId?: string;
  readonly entityName?: string;
  /** por que o Roi propôs (rótulo honesto no card/nudge). */
  readonly rationale: string;
}

// ─── Autonomia ───────────────────────────────────────────────────────────
export type AutonomyLevel = "notify" | "suggest" | "act_safe" | "act_full";

export interface AutonomyPolicy {
  /** decisão por origem da ação */
  readonly bySource: Readonly<Record<ActionSource, AutonomyLevel>>;
  /**
   * Autonomia POR-AÇÃO (B): por tool-key (as 6 gateáveis), VENCE o `bySource`; ausente =
   * herda a origem. O toolKey das 4 de escrita == o `Action.type`. Vive aqui (jsonb) — sem
   * migração. As 2 de criação (`create_campaign`/`duplicate_scale`) governam o proativo (C).
   * Mapa ESPARSO em runtime (chaves ausentes = herda); leia sempre com `byAction?.[k] ?? …`.
   */
  readonly byAction?: Readonly<Record<string, AutonomyLevel>>;
  /**
   * Kill-switch da AUTO-CONFIG POR CHAT (Bloco 2, S2.3): o dono muda a config do
   * agente conversando no WhatsApp (sob eco+confirma). Ausente OU true = habilitado
   * (default ON); false = desligado (a config passa a ser só pelo site). Vive aqui
   * (jsonb `autonomy_policy`) por ser uma política de autonomia — sem migração.
   */
  readonly autoConfigViaChat?: boolean;
  /**
   * Preferência do passo AGRESSIVO da escala (Fatia 7): "ask" (default — pergunta subir vs
   * duplicar), "raise" (sempre sobe o budget no limite seguro) ou "duplicate" (sempre duplica).
   * Tira a fricção do perguntar-toda-vez pro power-user. Ausente = "ask". Vive aqui (jsonb) —
   * sem migração.
   */
  readonly scaleAggressivePreference?: "ask" | "raise" | "duplicate";
  /**
   * Ativação da CRIAÇÃO (v1): "paused" (default — nasce pausada + cria a aprovação de ativação, o
   * 2º OK pra ativar depois) × "active" (nasce ATIVA direto, sem 2º OK). Os dois SEMPRE avisam no
   * WhatsApp. Escolha do dono na UI do agente; jsonb `autonomy_policy` — sem migração.
   */
  readonly creationActivation?: "paused" | "active";
}

/** Como a criação nasce (v1). "paused" = pausada + 2º OK de ativação; "active" = ativa direto. */
export type CreationActivation = "paused" | "active";
/** Default conservador (v1): nasce pausada, o dono revisa e ativa. */
export const DEFAULT_CREATION_ACTIVATION: CreationActivation = "paused";
/** Resolve a ativação da criação da política do agente (ausente = default "paused"). PURO. */
export function resolveCreationActivation(policy?: Pick<AutonomyPolicy, "creationActivation">): CreationActivation {
  return policy?.creationActivation ?? DEFAULT_CREATION_ACTIVATION;
}

// ─── Sinais de mudança material (F4 — alerta proativo dirigido) ─────────────
// Taxonomia NEUTRA de um sinal temporal que DIRIGE a análise (não é veredito): a
// detecção determinística barata (D-1 fechado vs baseline) o produz, o run de
// análise investiga. Ponto de convergência com sinais EXTERNOS do cliente (Fatia 9).
export type SignalMetric = "results" | "spend" | "cpa";
export type SignalDirection = "drop" | "spike" | "zeroed" | "reactivated";

export interface SignalEntityRef {
  readonly level: EntityLevel;
  readonly id: string;
  readonly name?: string;
}

export interface SignalFinding {
  readonly entityRef: SignalEntityRef;
  readonly metric: SignalMetric;
  readonly direction: SignalDirection;
  /** magnitude da mudança vs baseline (% absoluto). */
  readonly magnitudePct: number;
  readonly current: number;
  readonly baseline: number;
}

// ─── Visão de criativo (3b-2) ──────────────────────────────────────────────
/** Análise multimodal de um criativo (resultado curado, cacheável por conteúdo). */
export interface CreativeVisionResult {
  /** o que o criativo comunica (1-2 frases). */
  readonly summary: string;
  /** gancho/promessa principal, se identificável. */
  readonly hook?: string;
  /** ângulo/apelo central (ex: prova social, dor, autoridade) — decomposição (6c). */
  readonly angle?: string;
  /** formato (antes-depois / depoimento / UGC / talking-head / oferta) — decomposição (6c). */
  readonly format?: string;
  /** chamada pra ação percebida — decomposição (6c). */
  readonly cta?: string;
  /** corpo/argumento central da mensagem (§Bloco 2) — o "meio" entre gancho e CTA. */
  readonly body?: string;
  /** força de prova percebida (§Bloco 2): antes/depois, autoridade médica, depoimento. */
  readonly proofStrength?: CreativeProofStrength;
  /** nº de gatilhos de persuasão de Cialdini presentes (0-7): reciprocidade, compromisso/
   *  coerência, prova social, autoridade, afinidade, escassez, unidade (S4b). Extraível do
   *  próprio criativo, sem dado externo. */
  readonly persuasionSignals?: number;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  /** qualidade geral 0-10 (heurística do modelo). */
  readonly score?: number;
}

/** Força de prova de um criativo (§Bloco 2) — descritivo; não altera tier/score. */
export type CreativeProofStrength = "weak" | "medium" | "strong";

// ─── Transcrição de áudio (STT) ────────────────────────────────────────────
/** Resultado de uma transcrição de áudio (texto + custo real p/ metering §11). */
export interface TranscriptionResult {
  readonly text: string;
  /** id do modelo efetivamente usado (reportado pelo provider ou o configurado). */
  readonly model: string;
  /** custo real em USD reportado pelo provider; ausente ≠ zero (regra de LLMUsage). */
  readonly costUsd?: number;
  /** duração do áudio em segundos (quando o provider reporta). */
  readonly durationSec?: number;
  readonly tokensUsed?: number;
}

// ─── Metering ────────────────────────────────────────────────────────────
export interface UsageEvent {
  readonly orgId: OrgId;
  readonly runId?: RunId;
  /** Conta atribuída diretamente (Fatia 6c) — chat (conta em foco) e runs (backfill). */
  readonly adAccountId?: string;
  readonly type: string; // genérico/extensível
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provider?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

// ─── Credencial cripto ───────────────────────────────────────────────────
export interface EncryptedPayload {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly keyVersion: number;
}
