// Resolução PURA da janela de análise (últimos N dias) e da baseline (os N
// anteriores). Datas em "YYYY-MM-DD". Testável sem relógio (recebe o `today`).

export interface DateWindow {
  readonly since: string;
  readonly until: string;
}

export function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * Janela = [today-(windowDays-1), today]; baseline = os `baselineDays` dias
 * imediatamente anteriores à janela. Ex: today=2026-08-18, 7d →
 * janela 2026-08-12..2026-08-18; baseline 2026-08-05..2026-08-11.
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
