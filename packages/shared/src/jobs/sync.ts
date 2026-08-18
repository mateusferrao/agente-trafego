/**
 * Contrato do job de sync de insights (produtor = API admin / cron; consumidor =
 * worker). Fila própria (separada da análise) — o sync coleta a série temporal; a
 * análise consome. Evita string mágica e drift entre processos.
 */
export const SYNC_QUEUE = "insights-sync";
export const INSIGHTS_SYNC_JOB = "insights-sync-run";

export type SyncTrigger = "manual" | "cron" | "on_demand";

export type InsightsSyncPayload = {
  /** id da linha em `ad_accounts` (o worker carrega + descriptografa o token). */
  readonly accountId: string;
  /** org dona da conta — o worker re-escopa a query (defesa cross-tenant, §12). */
  readonly orgId: string;
  readonly trigger: SyncTrigger;
};
