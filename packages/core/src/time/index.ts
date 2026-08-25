// Data-em-fuso (puro): calcula "hoje"/janelas no timezone configurado (org), não em UTC.
// Motivação: `insights_snapshots.date` é gravado no fuso da conta Meta; calcular "hoje" em
// UTC (`new Date().toISOString().slice(0,10)`) escorrega 1 dia à noite (ex.: 23:00 BRT já é
// o dia seguinte em UTC), errando a janela de consulta. Usa `Intl.DateTimeFormat` nativo
// (sem dep) e reusa a aritmética de calendário de `sync` (`addDays` sobre "YYYY-MM-DD").

import { addDays } from "../sync/index.js";

/** "YYYY-MM-DD" do dia CIVIL de `now` no fuso `tz` (ex.: "America/Sao_Paulo"). */
export function todayInTz(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "YYYY-MM-DD" do início de uma janela de `days` dias que TERMINA hoje (no fuso `tz`).
 *  `days=1` → hoje; `days=7` → 6 dias atrás. Espelha o `isoDaysAgo` antigo, mas em fuso. */
export function daysAgoInTz(now: Date, tz: string, days: number): string {
  return addDays(todayInTz(now, tz), -(days - 1));
}

/** Offset (ms) do fuso `tz` no instante `at` = (relógio de parede em `tz` lido como UTC) − `at`.
 *  Ex.: BRT (UTC-3) → -10_800_000. */
export function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const p = (t: string): number => Number(parts.find((x) => x.type === t)?.value ?? "0");
  // "24" de hour em meia-noite vira 0 em alguns engines — normaliza.
  const hour = p("hour") % 24;
  const asUtc = Date.UTC(p("year"), p("month") - 1, p("day"), hour, p("minute"), p("second"));
  return asUtc - at.getTime();
}

/** Instante UTC da meia-noite do dia CIVIL de `now` no fuso `tz`. */
export function startOfDayInTz(now: Date, tz: string): Date {
  const midnightUtc = Date.parse(`${todayInTz(now, tz)}T00:00:00Z`);
  return new Date(midnightUtc - tzOffsetMs(now, tz));
}
