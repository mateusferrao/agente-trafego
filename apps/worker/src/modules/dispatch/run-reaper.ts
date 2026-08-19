// Reaper de runs presos (3b): um crash DURO (OOM/SIGKILL/eviction) entre criar o
// run e fechá-lo (closeRun) deixaria a linha em pending/running p/ sempre — e o
// índice único parcial in-flight bloquearia TODO run futuro daquele agente. Este
// job periódico marca como `failed` os runs in-flight velhos (> stale) → libera o
// índice e o agente volta a rodar na próxima cadência (degradação graciosa, §7).
//
// NÃO reapa `waiting_approval`: é uma espera legítima de HITL (expira em 24h por
// outra via — §8), não um crash. Casca (IO): só UPDATE.

import { and, inArray, lt, sql } from "drizzle-orm";
import { agentRuns, type Database } from "@trafego/db";
import type { Logger } from "pino";

/** Status in-flight que um crash pode deixar presos (approval fica de fora). */
const REAPABLE_STATUSES = ["pending", "running"] as const;
const MS_PER_MIN = 60 * 1000;
const STALE_RUN_NOTE = "Análise interrompida (o processo caiu antes de concluir). Rode de novo.";

export interface RunReaperDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** idade (min) além da qual um run in-flight é dado como preso. */
  readonly staleMinutes: number;
  /** relógio injetável (casca) — corte da janela. */
  readonly now?: () => Date;
}

export function createRunReaper(deps: RunReaperDeps) {
  const clock = deps.now ?? (() => new Date());

  /** Marca como failed os runs presos além do limite. Retorna quantos reapou. */
  async function reapStale(): Promise<number> {
    const cutoff = new Date(clock().getTime() - deps.staleMinutes * MS_PER_MIN);
    const reaped = await deps.db
      .update(agentRuns)
      .set({ status: "failed", summary: STALE_RUN_NOTE, finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(inArray(agentRuns.status, [...REAPABLE_STATUSES]), lt(agentRuns.createdAt, cutoff)))
      .returning({ id: agentRuns.id });
    if (reaped.length > 0) {
      deps.logger.warn({ count: reaped.length }, "reaper:runs presos marcados como failed");
    }
    return reaped.length;
  }

  return { reapStale };
}
