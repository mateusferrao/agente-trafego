/**
 * Contrato do job de análise (Grafo A), compartilhado entre o produtor (API) e o
 * consumidor (worker) — evita string mágica e drift de payload entre processos.
 * A fila é a mesma ("agent-runs"); o worker distingue por `mode` (execute|resume).
 */
export const AGENT_RUNS_QUEUE = "agent-runs";
export const AGENT_RUN_JOB = "agent-run";

export type AgentRunTrigger = "cron" | "on_demand";

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
