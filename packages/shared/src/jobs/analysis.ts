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
