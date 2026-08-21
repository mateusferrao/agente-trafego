/**
 * Contrato do job de sync de insights (produtor = API admin / cron; consumidor =
 * worker). Fila própria (separada da análise) — o sync coleta a série temporal; a
 * análise consome. Evita string mágica e drift entre processos.
 */
export const SYNC_QUEUE = "insights-sync";
export const INSIGHTS_SYNC_JOB = "insights-sync-run";

export type SyncTrigger = "manual" | "cron" | "on_demand";

/**
 * Fila + schedule do SWEEP de frescura (6a): um Job Scheduler recorrente (singleton,
 * intervalo = `INSIGHTS_FRESH_THRESHOLD_MIN`) enfileira aqui; o worker varre as contas
 * ativas, aplica `shouldSync` e enfileira sync-only só p/ as velhas (stagger). Chave
 * estável (idempotente).
 */
export const INSIGHTS_SWEEP_QUEUE = "insights-sweep";
export const INSIGHTS_SWEEP_SCHEDULE_KEY = "sweep:insights";
export type InsightsSweepTickPayload = Record<string, never>;

export type InsightsSyncPayload = {
  /** id da linha em `ad_accounts` (o worker carrega + descriptografa o token). */
  readonly accountId: string;
  /** org dona da conta — o worker re-escopa a query (defesa cross-tenant, §12). */
  readonly orgId: string;
  readonly trigger: SyncTrigger;
};

/**
 * jobId do sync-only por conta. O sweep periódico (`cron`) usa a chave base e enfileira
 * com delay (stagger); um trigger IMEDIATO (`manual`/`on_demand` = botão/lazy) usa uma
 * chave distinta (`:now`) p/ NÃO coalescer no job atrasado do sweep (senão o "atualizar
 * agora" herdaria o delay e só rodaria minutos depois). Cada classe dedupe em si.
 */
export function insightsSyncJobId(accountId: string, trigger: SyncTrigger): string {
  return trigger === "cron" ? `sync:${accountId}` : `sync:${accountId}:now`;
}

/**
 * Monta o `JobSpec` do sync-only (produtor = API/força + sweep). `jobId` por conta
 * serializa/dedupe; `removeOn*` libera a chave ao concluir/falhar p/ o próximo sync não
 * ficar bloqueado. Puro (sem runtime) → DRY entre api e worker, testável.
 */
export function buildInsightsSyncJob(payload: InsightsSyncPayload) {
  return {
    queue: SYNC_QUEUE,
    name: INSIGHTS_SYNC_JOB,
    payload,
    idempotencyKey: insightsSyncJobId(payload.accountId, payload.trigger),
    removeOnComplete: true,
    removeOnFail: true,
  } as const;
}
