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

function parseIsoDate(s: string): Date {
  const p = s.split("-");
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}

function formatIsoDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const dt = parseIsoDate(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatIsoDate(dt);
}

function maxIsoDate(a: string, b: string): string {
  return a >= b ? a : b;
}
