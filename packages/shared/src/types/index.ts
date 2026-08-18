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
