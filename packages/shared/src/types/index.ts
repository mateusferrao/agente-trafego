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
  readonly dailyBudget?: number;
  readonly lifetimeBudget?: number;
  /** Objetivo próprio da entidade (o que ela otimiza) — base do CPA/ROAS + intenção p/ análise. */
  readonly objective?: EntityObjective;
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
}

// ─── Conversão (genérico, agnóstico de plataforma) ───────────────────────
// O vocabulário/mapeamento específico de cada plataforma (Meta action_type,
// optimization_goal, etc.) vive SÓ no adapter. O core e o restante do sistema
// falam esta taxonomia neutra — adicionar Google/TikTok = novo adapter mapeando
// pro mesmo enum, sem tocar no core.
export type ConversionGoal =
  | "purchase"
  | "lead"
  | "registration"
  | "initiate_checkout"
  | "add_to_cart"
  | "view_content"
  | "add_payment_info"
  | "search"
  | "contact"
  | "subscribe"
  | "start_trial"
  | "submit_application"
  | "messaging_started"
  | "app_install"
  | "custom";

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
  /** Funil de messaging da entidade (só quando há dado) — qualidade do lead. */
  readonly funnel?: FunnelSummary;
}

export interface Anomaly {
  readonly entityId: string;
  readonly metric: string;
  readonly zScore: number;
  readonly note: string;
}

export interface AgentGoals {
  readonly targetCPA?: number;
  readonly targetROAS?: number;
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
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  /** qualidade geral 0-10 (heurística do modelo). */
  readonly score?: number;
}

// ─── Metering ────────────────────────────────────────────────────────────
export interface UsageEvent {
  readonly orgId: OrgId;
  readonly runId?: RunId;
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
