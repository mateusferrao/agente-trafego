// ─── Ids (branded strings) ───────────────────────────────────────────────
export type OrgId = string & { readonly __brand: "OrgId" };
export type AdAccountId = string & { readonly __brand: "AdAccountId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type RunId = string & { readonly __brand: "RunId" };
export type ContactId = string & { readonly __brand: "ContactId" };
export type ApprovalId = string & { readonly __brand: "ApprovalId" };

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
  /** Objetivo próprio da entidade (o que ela otimiza) — base do CPA/ROAS + intenção p/ análise. */
  readonly objective?: EntityObjective;
  /** Perfil de público do adset (§Bloco 2) — presente só no nível adset, quando há targeting. */
  readonly audience?: AudienceProfile;
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
  readonly ageMin?: number;
  readonly ageMax?: number;
  /** principais interesses/comportamentos (top-N nomes), quando houver. */
  readonly interests?: readonly string[];
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
  readonly thumbnailUrl?: string;
  readonly videoId?: string;
  /**
   * Frames-pôster p/ a visão (Fatia 6c): imagem estática = 1; vídeo = N frames HD
   * espaçados (Meta `/{video_id}?fields=thumbnails`, 1080p) em vez do selo pequeno.
   * O resolver manda todos como conteúdo multimodal. Ordem = abertura → fim.
   */
  readonly posterFrames?: readonly string[];
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
}

// ─── Autonomia ───────────────────────────────────────────────────────────
export type AutonomyLevel = "notify" | "suggest" | "act_safe" | "act_full";

export interface AutonomyPolicy {
  /** decisão por origem da ação */
  readonly bySource: Readonly<Record<ActionSource, AutonomyLevel>>;
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
