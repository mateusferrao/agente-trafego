// Monta as comparações D-1 (dia fechado) vs baseline (média/dia dos anteriores) a
// partir dos snapshots de insights, por entidade. PURO/testável — o IO (query) fica
// no gate. Só dias FECHADOS (< hoje): o dia corrente tem atribuição incompleta na
// Meta (falso positivo). Entidade com < 2 dias fechados é ignorada (sem baseline).

import type { SignalComparison } from "@trafego/core";
import type { EntityLevel } from "@trafego/shared";

/** Uma linha de snapshot já achatada (um dia de uma entidade). */
export interface SnapshotDay {
  readonly entityId: string;
  readonly entityName?: string;
  readonly level: EntityLevel;
  readonly date: string; // YYYY-MM-DD
  readonly spend?: number;
  readonly results?: number;
  readonly cpa?: number;
}

function avg(nums: readonly (number | undefined)[]): number | undefined {
  const vals = nums.filter((n): n is number => typeof n === "number");
  return vals.length === 0 ? undefined : vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Agrupa por entidade e monta a comparação: current = dia fechado mais recente;
 * baseline = média/dia dos dias fechados anteriores. `today` (YYYY-MM-DD) exclui o
 * dia corrente (não-fechado).
 */
export function buildSignalComparisons(rows: readonly SnapshotDay[], today: string): SignalComparison[] {
  const closed = rows.filter((r) => r.date < today);
  const byEntity = new Map<string, SnapshotDay[]>();
  for (const r of closed) {
    const list = byEntity.get(r.entityId) ?? [];
    list.push(r);
    byEntity.set(r.entityId, list);
  }

  const out: SignalComparison[] = [];
  for (const [entityId, days] of byEntity) {
    if (days.length < 2) continue; // sem baseline confiável
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const current = sorted[sorted.length - 1]!;
    const prior = sorted.slice(0, -1);
    const bResults = avg(prior.map((d) => d.results));
    const bSpend = avg(prior.map((d) => d.spend));
    const bCpa = avg(prior.map((d) => d.cpa));
    out.push({
      entityRef: { level: current.level, id: entityId, ...(current.entityName ? { name: current.entityName } : {}) },
      current: {
        ...(typeof current.results === "number" ? { results: current.results } : {}),
        ...(typeof current.spend === "number" ? { spend: current.spend } : {}),
        ...(typeof current.cpa === "number" ? { cpa: current.cpa } : {}),
      },
      baseline: {
        ...(bResults !== undefined ? { results: bResults } : {}),
        ...(bSpend !== undefined ? { spend: bSpend } : {}),
        ...(bCpa !== undefined ? { cpa: bCpa } : {}),
      },
    });
  }
  return out;
}

/** Escolhe o sinal mais forte (maior magnitude) — 1 alerta por conta por vez. */
export function strongestSignal<T extends { magnitudePct: number }>(findings: readonly T[]): T | undefined {
  return [...findings].sort((a, b) => b.magnitudePct - a.magnitudePct)[0];
}
