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
  /** principais interesses/comportamentos (top-N nomes), quando houver. */
  readonly interests?: readonly string[];
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
  readonly [key: string]: number | undefined;
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
}

/**
 * Forma persistida em `insights_snapshots.metrics_json` (jsonb): escalares +
 * conversões normalizadas + breakdown cru (fidelidade p/ re-derivar sem re-sync).
 */
export interface StoredInsightMetrics {
  readonly metrics: InsightMetrics;
  readonly conversions?: ConversionBreakdown;
  readonly rawActions?: Readonly<Record<string, number>>;
}

export interface Creative {
  readonly id: string;
  readonly adId: string;
  readonly name?: string;
  readonly body?: string;
  readonly title?: string;
  readonly callToAction?: string;
  readonly imageUrl?: string;
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

// ─── Ações do agente ─────────────────────────────────────────────────────
export type ActionType =
  | "pause_entity"
  | "resume_entity"
  | "adjust_budget"
  | "set_status";

export type ActionSource = "playbook" | "llm";
export type RiskLevel = "low" | "medium" | "high";

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

/** Sinais de saúde nomeados (estende a detecção de anomalias com semântica de tráfego). */
export type HealthSignal = "creative_fatigue" | "audience_saturation" | "low_volume";

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
  /** Perfil de público do adset (§Bloco 2) — estágio + resumo compacto do targeting. */
  readonly audience?: AudienceProfile;
  /** Base de medição vs a conversão de negócio do agente (§Fatia 4). */
  readonly conversionBasis?: ConversionBasis;
  /** Métrica-proxy do objetivo da entidade — presente só quando `conversionBasis === "proxy"`. */
  readonly proxy?: ConversionProxy;
  /** Funil de messaging da entidade (só quando há dado) — qualidade do lead. */
  readonly funnel?: FunnelSummary;
  /** Classe de desempenho relativa à meta + à conta (Fatia 6c). */
  readonly tier?: PerformanceTier;
  /** Sinais de saúde detectados (fadiga/saturação/baixo volume) — Fatia 6c. */
  readonly healthSignals?: readonly HealthSignal[];
  /** Elegibilidade de decisão (significância/learning) — insumo do guard (Fatia 6c). */
  readonly eligibility?: DecisionEligibility;
  /** Referência de plataforma no cold-start (sem meta e sem histórico) — Fatia 6c. */
  readonly benchmarkRef?: BenchmarkRef;
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
  /** estágio de público DOMINANTE da campanha (§Bloco 2) — do adset de maior gasto. */
  readonly stage?: AudienceStage | null;
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
  readonly creatives: readonly Creative[]; // só flagados (com imagem p/ visão)
  readonly playbookCandidates: readonly CandidateAction[];
  readonly memory: {
    readonly objectives: readonly string[];
    readonly pastActions: readonly string[];
    readonly rejected: readonly string[];
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

export const CREATION_OPPORTUNITY_KINDS = ["scale_winner", "refresh_fatigued", "cold_start"] as const;
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

/** Uma variação de copy (as N variações compartilham a mesma mídia). */
export interface CopyVariant {
  readonly primaryText: string;
  readonly headline: string;
  readonly description?: string;
  readonly cta?: CtaType;
  /** nome do anúncio desta variação (a variação É o anúncio, 1:1). Ausente → derivado no apply. */
  readonly adName?: string;
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
export interface ResolvedAudienceSnapshot {
  readonly geo: {
    readonly countries?: readonly string[];
    readonly regions?: readonly { readonly key: string; readonly name: string }[];
    readonly cities?: readonly { readonly key: string; readonly name: string }[];
  };
  readonly ageMin?: number;
  readonly ageMax?: number;
  /** decidido por `resolveExpansion` (packages/ads-meta) — ausente na fonte já vira 0 explícito
   *  aqui, nunca chega "ausente" neste snapshot (P1: nunca herda expansão às cegas). */
  readonly expansionRaw: { readonly advantageAudience: 0 | 1; readonly relaxCustomAudience: 0 | 1; readonly relaxLookalike: 0 | 1 };
}

/**
 * Targeting NEUTRO do rascunho. No MVP: reusar o público provado de um adset OU
 * amplo (Advantage+). Construir targeting novo por interesses = fast-follow.
 */
export type TargetingSpec =
  | {
      readonly kind: "reuse_adset";
      readonly sourceAdsetId: string;
      /** snapshot resolvido no propose (subfatia 2) — ausente = rascunho pré-adendo, apply cai no
       *  caminho antigo (lê a Meta ao vivo). Migração de graça, sem alterar dado já persistido. */
      readonly resolved?: ResolvedAudienceSnapshot;
    }
  | { readonly kind: "advantage_plus" }
  /**
   * Segmentado por público (Fatia 7): inclui `includeIds`, exclui `excludeIds` (custom
   * audiences reais da BM), expansões (advantage/lookalike/geo) zeradas. `sourceAdsetId`
   * (opcional) = herda geo/idade de um adset-fonte (CÓPIA); ausente = geo amplo + o público
   * (CRIAR-DO-ZERO com público indicado). Vocabulário Meta fica no adapter.
   */
  | {
      readonly kind: "custom_audiences";
      readonly sourceAdsetId?: string;
      readonly includeIds: readonly string[];
      readonly excludeIds: readonly string[];
      /** base de geo/idade herdada do `sourceAdsetId` (quando presente) — mesmo papel do
       *  `resolved` acima, ausente = caminho antigo (lê ao vivo). */
      readonly resolvedBase?: Pick<ResolvedAudienceSnapshot, "geo" | "ageMin" | "ageMax">;
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
  /** nº de variações de copy num adset (mesma mídia). */
  readonly variantsCount?: number;
  readonly copyVariants?: readonly CopyVariant[];
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

/** Otimização de orçamento (neutro): campanha (CBO) × conjunto (ABO). */
export type BudgetMode = "cbo" | "abo";

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
