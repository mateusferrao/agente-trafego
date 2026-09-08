// Reaper de rascunhos de criação presos em `creating` (G7): um crash DURO (OOM/SIGKILL/eviction) no
// MEIO da saga de criação deixa a linha em `creating` p/ sempre. Dois danos: (1) o claim atômico de
// aplicação só aceita `proposed|failed` → nenhum retry reivindica (rascunho travado); (2)
// `countCreationsLast24h` conta `creating` como in-flight → o zumbi consome o cap de campanhas/dia
// indefinidamente. Este sweep marca como `failed` os `creating` SEM PROGRESSO há > stale (via
// `updatedAt`, que a saga bumpa a cada passo) → libera o cap e torna o rascunho retomável (re-aprovar
// resume dos `createdIds`). NÃO reapa um job ativo: `stale` é folgado (> duração normal da saga).
// Espelha `run-reaper.ts`. Casca (IO): só UPDATE.

import { and, eq, lt } from "drizzle-orm";
import { campaignDrafts, type Database } from "@trafego/db";
import type { Logger } from "pino";

const MS_PER_MIN = 60 * 1000;

/** Marca como `failed` os rascunhos presos em `creating` sem progresso além do limite. Retorna
 *  quantos reapou. `now` injetável (casca) p/ testar o corte da janela. */
export async function reapStaleCreatingDrafts(
  db: Database,
  logger: Logger,
  staleMinutes: number,
  now: () => Date = () => new Date(),
): Promise<number> {
  const cutoff = new Date(now().getTime() - staleMinutes * MS_PER_MIN);
  const reaped = await db
    .update(campaignDrafts)
    .set({ status: "failed" }) // updatedAt bumpa via $onUpdate
    .where(and(eq(campaignDrafts.status, "creating"), lt(campaignDrafts.updatedAt, cutoff)))
    .returning({ id: campaignDrafts.id });
  if (reaped.length > 0) {
    logger.warn({ count: reaped.length }, "reaper:rascunhos presos em creating → failed (retomáveis, cap liberado)");
  }
  return reaped.length;
}
