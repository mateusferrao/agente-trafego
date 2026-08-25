// Severidade + nota humana da degradação graciosa (run "parcial") — PURO.
// Torna o "parcial" honesto: `metrics`/`entities` faltando = análise incompleta (grave);
// só `creative_vision`/`campaign_analysis`/`action_apply` = métricas intactas (leve).
// A nota alarmista de antes ("a Meta limitou") só aparece no caso grave.

import type { PartialReason } from "@trafego/shared";

export type PartialSeverity = "none" | "soft" | "hard";

/** Motivos que significam dado da análise INCOMPLETO (graves). */
const HARD_REASONS: ReadonlySet<PartialReason> = new Set<PartialReason>(["metrics", "entities"]);

/** `hard` se algum motivo grave; senão `soft` (métricas completas); `none` se nenhum. */
export function partialSeverity(reasons: readonly PartialReason[]): PartialSeverity {
  if (reasons.length === 0) return "none";
  return reasons.some((r) => HARD_REASONS.has(r)) ? "hard" : "soft";
}

/** Nota proporcional à gravidade (null quando não há degradação). Sentence case, §DESIGN. */
export function partialNote(reasons: readonly PartialReason[]): string | null {
  switch (partialSeverity(reasons)) {
    case "none":
      return null;
    case "hard":
      return "Análise parcial — a Meta limitou as chamadas ou alguns dados não vieram desta vez. Tente de novo em alguns minutos.";
    case "soft":
      return "As métricas vieram completas; só o detalhe de alguns criativos ou campanhas não veio desta vez (a Meta limitou algumas chamadas). Não afeta os números.";
  }
}
