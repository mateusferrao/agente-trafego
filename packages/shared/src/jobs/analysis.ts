/**
 * Contrato do job de análise (Grafo A), compartilhado entre o produtor (API) e o
 * consumidor (worker) — evita string mágica e drift de payload entre processos.
 * A fila é a mesma ("agent-runs"); o worker distingue por `mode` (execute|resume).
 */
export const AGENT_RUNS_QUEUE = "agent-runs";
export const AGENT_RUN_JOB = "agent-run";

/**
 * Fila do DISPATCH do cron (3b): o Job Scheduler recorrente enfileira aqui; o
 * worker de dispatch cria o `agent_runs` (+guards) e então enfileira o `execute`
 * na AGENT_RUNS_QUEUE. Separar mantém o scheduler burro (não cria run) e o
 * dispatch idempotente (índice único in-flight fecha o TOCTOU).
 */
export const AGENT_CRON_QUEUE = "agent-cron-dispatch";
export const AGENT_CRON_JOB = "agent-cron";

/**
 * Fila do REAPER (3b): um Job Scheduler recorrente enfileira aqui; o worker marca
 * como `failed` os runs presos in-flight (crash duro entre criar o run e fechá-lo)
 * — sem isso o índice único parcial travaria o agente p/ sempre. Chave estável.
 */
export const AGENT_REAPER_QUEUE = "agent-run-reaper";
export const AGENT_REAPER_JOB = "agent-run-reaper";
export const AGENT_REAPER_SCHEDULE_KEY = "reaper:runs";

/** Tick do reaper — sem payload (varre todos os orgs). */
export type AgentReaperTickPayload = Record<string, never>;

/**
 * Fila de EXPIRAÇÃO de aprovações (5b): um Job Scheduler recorrente enfileira aqui; o
 * worker marca como `expired` as pendentes vencidas (24h sem resposta). Chave estável.
 */
export const APPROVAL_EXPIRY_QUEUE = "approval-expiry";
export const APPROVAL_EXPIRY_SCHEDULE_KEY = "expiry:approvals";
export type ApprovalExpiryTickPayload = Record<string, never>;

/**
 * Fila de RE-SYNC do schedule (Fatia 4 corte 2): a API só persiste a cadência e
 * enfileira aqui; o WORKER (dono único do scheduler) recarrega o `CadenceSpec` da
 * conta + o fuso da org, deriva o cron e faz upsert/remove. Mantém a API fora do
 * domínio de agenda (sem builder de ScheduleSpec na casca HTTP).
 */
export const SCHEDULE_RESYNC_QUEUE = "schedule-resync";
export const SCHEDULE_RESYNC_JOB = "schedule-resync";
export type ScheduleResyncPayload = {
  readonly orgId: string;
  readonly adAccountId: string;
};

/**
 * Fila de UNDO de ação (5a): a API valida a posse + enfileira; o WORKER (dono do
 * governor/escrita) carrega o `agent_tool_calls`, reaplica o `before_state` na Meta
 * e registra o undo. Escrita fica no worker (governor + auditoria), não na casca HTTP.
 */
export const ACTION_UNDO_QUEUE = "action-undo";
export const ACTION_UNDO_JOB = "action-undo";
export type ActionUndoPayload = {
  readonly orgId: string;
  readonly adAccountId: string;
  readonly toolCallId: string;
  /** ignora o re-check de drift ("reverter mesmo assim") — 5b. */
  readonly force?: boolean;
};

/**
 * Fila de APLICAÇÃO de aprovação (5b): a API valida a posse + enfileira; o WORKER
 * carrega a `approval`, RE-CHECA o estado fresco na Meta + guardrail e aplica via o
 * executor. Escrita no worker (governor + auditoria), nunca na casca HTTP. Deriva a
 * conta do próprio approval (não confia em payload extra).
 */
export const APPROVAL_APPLY_QUEUE = "approval-apply";
export const APPROVAL_APPLY_JOB = "approval-apply";
export type ApprovalApplyPayload = {
  readonly orgId: string;
  readonly approvalId: string;
};

export type AgentRunTrigger = "cron" | "on_demand";

/** Payload do dispatch de cron: sem `runId` (o dispatch é quem cria o run). */
export type AgentCronDispatchPayload = {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
};

/**
 * Novo run de análise (cron ou on-demand). O run já nasce criado (pending) na API.
 * `type` (não `interface`) p/ ganhar o index signature implícito → aceito como
 * `JobSpec.payload` (Record<string, unknown>) sem cast.
 */
export type AgentRunExecutePayload = {
  readonly mode: "execute";
  readonly trigger: AgentRunTrigger;
  /** id de `agent_runs` (criado pela API; o worker abre→fecha). */
  readonly runId: string;
  /** org dona — o worker re-escopa toda query (defesa cross-tenant, §12). */
  readonly orgId: string;
  readonly agentId: string;
  /** id de `ad_accounts` (o worker carrega + descriptografa o token). */
  readonly adAccountId: string;
};
