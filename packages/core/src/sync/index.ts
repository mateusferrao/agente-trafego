// Planejamento PURO da janela de sync de insights. Decide QUE intervalo de datas
// buscar dado o que já temos — sem IO, sem `Date.now()` (o `today` é injetado),
// determinístico e testável sem rede. A idempotência da gravação (upsert por
// (conta, entidade, dia)) torna o overlap da janela de re-fetch seguro.
//
// Dois conceitos de "atribuição" NÃO se confundem aqui:
//  - janela de atribuição da Meta (quem leva o crédito) = detalhe do adapter;
//  - `refetchWindowDays` = quantos dias recentes RE-baixar p/ pegar conversões
//    que a plataforma atribui a dias passados com atraso (frescura do snapshot).

export interface SyncWindowInput {
  /** Data de referência (YYYY-MM-DD), injetada pela casca. */
  readonly today: string;
  /** Última data já presente no snapshot p/ (conta, nível); null = 1º sync. */
  readonly latestSnapshotDate: string | null;
  /** Quantos dias finais re-baixar (janela de re-fetch de atribuição). */
  readonly refetchWindowDays: number;
  /** Janela de retenção rolante — não busca (nem guarda) além disso. */
  readonly retentionDays: number;
}

export interface SyncWindow {
  readonly since: string; // YYYY-MM-DD (inclusivo)
  readonly until: string; // YYYY-MM-DD (inclusivo)
}

/**
 * `null` quando o intervalo calculado é vazio (`since > until`) — acontece quando
 * `latestSnapshotDate` está suficientemente no futuro (dado inconsistente/clock
 * skew). Caso contrário, o intervalo contíguo que cobre re-fetch de atribuição +
 * dias novos + backfill de buraco, sempre clampado à retenção.
 */
export function planSyncWindow(input: SyncWindowInput): SyncWindow | null {
  const { today, latestSnapshotDate, refetchWindowDays, retentionDays } = input;

  const retentionStart = addDays(today, -(retentionDays - 1));
  const since =
    latestSnapshotDate === null
      ? retentionStart
      : maxIsoDate(retentionStart, addDays(latestSnapshotDate, -(refetchWindowDays - 1)));
  const until = today;

  if (since > until) return null; // ISO YYYY-MM-DD compara cronologicamente
  return { since, until };
}

export interface ShouldSyncInput {
  /** Quando o snapshot mais novo foi atualizado (ms epoch) = última vez que buscamos;
   *  `null` = conta nunca sincronizada. */
  readonly latestSnapshotAt: number | null;
  /** Agora (ms epoch), injetado pela casca (sem `Date.now()` no core). */
  readonly now: number;
  /** Limite de frescura em minutos (`INSIGHTS_FRESH_THRESHOLD_MIN`). */
  readonly thresholdMin: number;
}

/**
 * Porta de staleness (pura): `true` = o dado passou do limite (ou nunca foi buscado) →
 * precisa de um sync-only. Compartilhada pelos 4 gatilhos (análise inline, sweep, lazy,
 * botão) p/ dedupe natural. `latest` no futuro (clock skew) = tratado como fresco.
 */
export function shouldSync(input: ShouldSyncInput): boolean {
  if (input.latestSnapshotAt === null) return true;
  const ageMs = input.now - input.latestSnapshotAt;
  return ageMs >= input.thresholdMin * 60_000;
}

export interface DateWindow {
  readonly since: string;
  readonly until: string;
}

/**
 * Janela de análise/leitura (pura): `[today-(windowDays-1), today]`; baseline = os
 * `baselineDays` dias imediatamente anteriores. Ex: today=2026-08-18, 7d → janela
 * 2026-08-12..2026-08-18; baseline 2026-08-05..2026-08-11. Reusada pelo worker
 * (análise) e pela API (KPIs ao vivo — 6a). `today` injetado → testável sem relógio.
 */
export function resolveWindows(
  today: string,
  windowDays: number,
  baselineDays: number,
): { readonly window: DateWindow; readonly baseline: DateWindow } {
  const until = today;
  const since = addDays(today, -(windowDays - 1));
  const baselineUntil = addDays(since, -1);
  const baselineSince = addDays(baselineUntil, -(baselineDays - 1));
  return { window: { since, until }, baseline: { since: baselineSince, until: baselineUntil } };
}

function parseIsoDate(s: string): Date {
  const p = s.split("-");
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}

function formatIsoDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const dt = parseIsoDate(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatIsoDate(dt);
}

function maxIsoDate(a: string, b: string): string {
  return a >= b ? a : b;
}
