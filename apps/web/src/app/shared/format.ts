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

/**
 * Rótulo data+hora ciente de "hoje": mesmo dia → só "HH:MM"; outro dia → "dd/mm HH:MM"
 * (+ ano se diferente). Evita "14:46" parecer hoje quando foi dias atrás.
 */
export function dateTimeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = TIME_FMT.format(d);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const dm = new Intl.DateTimeFormat(
    "pt-BR",
    d.getFullYear() === now.getFullYear()
      ? { day: "2-digit", month: "2-digit" }
      : { day: "2-digit", month: "2-digit", year: "2-digit" },
  ).format(d);
  return `${dm} ${time}`;
}

/**
 * Rótulo as-of (quando os números foram buscados da Meta pela última vez):
 * "atualizado às HH:MM" | "desatualizado · última atualização HH:MM" | "ainda não sincronizado".
 * O HH:MM é sempre o horário da última busca (não o momento em que ficou velho).
 */
export function asOfLabel(asOf: string | null, stale: boolean): string {
  if (!asOf) return "ainda não sincronizado";
  const t = dateTimeLabel(asOf); // hoje = "HH:MM"; outro dia = "dd/mm HH:MM"
  return stale ? `desatualizado · última atualização ${t}` : `atualizado ${t}`;
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
