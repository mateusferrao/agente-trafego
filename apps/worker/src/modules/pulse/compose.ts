// Composição do PULSO (F4) a partir do ÚLTIMO run persistido — PURA/testável. Sem
// rerun nem LLM: reusa o metrics_snapshot (scorecard + waste = money-shot) e as
// recomendações do run, montando o overview do redator determinístico do core
// (buildMessageFallback lidera pelo dinheiro). null = sem run útil → não manda pulso.

import type { MessageOverview } from "@trafego/core";

/** Recorte defensivo do metrics_snapshot (jsonb livre) que o pulso usa. */
export interface PulseRunSnapshot {
  readonly scorecard?: { readonly headline?: string };
  readonly waste?: { readonly wastedSpend?: number; readonly wastedPct?: number };
}

export interface PulseRunData {
  readonly accountName: string;
  readonly summary: string | null;
  readonly snapshot: PulseRunSnapshot | null;
  readonly recommendationTitles: readonly string[];
}

/** Monta o overview do pulso; null quando não há nada de substância pra dizer. */
export function composePulseOverview(run: PulseRunData): MessageOverview | null {
  const headline = run.snapshot?.scorecard?.headline?.trim();
  const summary = run.summary?.trim() ?? "";
  if (!headline && summary.length === 0) return null; // run sem síntese → nada a resumir

  const wastedSpend = run.snapshot?.waste?.wastedSpend;
  const wastedPct = run.snapshot?.waste?.wastedPct;
  const money =
    typeof wastedSpend === "number" && wastedSpend > 0
      ? { wastedSpend, wastedPct: typeof wastedPct === "number" ? wastedPct : 0 }
      : undefined;

  return {
    accountName: run.accountName,
    ...(headline ? { headline } : {}),
    summary,
    recommendations: run.recommendationTitles.map((title) => ({ title })),
    ...(money ? { money } : {}),
  };
}
