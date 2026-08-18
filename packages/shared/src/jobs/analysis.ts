/**
 * Contrato do job de análise, compartilhado entre o produtor (API) e o consumidor
 * (worker) — evita string mágica e drift de payload entre os processos.
 */
export const ANALYSIS_QUEUE = "agent-runs";
export const ANALYSIS_RUN_JOB = "analysis-run";

export type AnalysisTrigger = "manual" | "cron" | "on_demand";

export type AnalysisRunPayload = {
  /** id da linha em `ad_accounts` (o worker carrega + descriptografa o token). */
  readonly accountId: string;
  /** org dona da conta — o worker re-escopa a query (defesa cross-tenant, §12). */
  readonly orgId: string;
  readonly trigger: AnalysisTrigger;
};
