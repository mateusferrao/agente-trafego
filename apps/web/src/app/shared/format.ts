// Helpers de formatação compartilhados (Painel + detalhe da conta). Frescura (`stale`)
// vem do servidor — o web NÃO redefine o threshold (fonte única no backend, §13).

import type { TimelineTone } from "@ui";

const DEFAULT_CURRENCY = "BRL";
const TIME_FMT = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Valor monetário na moeda da conta (fallback BRL). */
export function money(value: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency ?? DEFAULT_CURRENCY }).format(value);
  } catch {
    return String(value);
  }
}

export function timeLabel(iso: string): string {
  return TIME_FMT.format(new Date(iso));
}

/** Rótulo as-of: "atualizado HH:MM" | "desatualizado (HH:MM)" | "sem dados ainda". */
export function asOfLabel(asOf: string | null, stale: boolean): string {
  if (!asOf) return "sem dados ainda";
  const t = timeLabel(asOf);
  return stale ? `desatualizado (${t})` : `atualizado ${t}`;
}

/** Data ISO "YYYY-MM-DD" → "dd/mm" (PT-BR, sem shift de fuso). */
function dayMonth(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/** Janela (since..until ISO date) → "dd/mm – dd/mm" (PT-BR). */
export function windowLabel(since: string, until: string): string {
  return `${dayMonth(since)} – ${dayMonth(until)}`;
}

/** Nota (A/B/C/D) → tom do badge. */
export function gradeTone(grade: string | null): TimelineTone {
  if (grade === "A" || grade === "B") return "success";
  if (grade === "C") return "warning";
  if (grade === "D") return "danger";
  return "neutral";
}
