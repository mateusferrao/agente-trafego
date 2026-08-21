import { and, eq, gte, lt, sql } from "drizzle-orm";
import { usageEvents, type Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { MeteringPort, UsageSummary } from "@trafego/shared/ports";
import type { UsageEvent } from "@trafego/shared/types";

/** Início/fim (UTC) do período "YYYY-MM". */
function periodRange(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  const year = y ?? new Date().getUTCFullYear();
  const month = (m ?? 1) - 1;
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

/**
 * Adapter Postgres da `MeteringPort` — grava `usage_events` (genérico type+payload,
 * §11) e agrega custo por período. Custo real do provider é a fonte; markup =
 * camada de billing (fast-follow), sem tocar aqui.
 */
export function createPostgresMetering(db: Database): MeteringPort {
  return {
    async record(event: UsageEvent): Promise<string> {
      const [row] = await db
        .insert(usageEvents)
        .values({
          orgId: event.orgId,
          ...(event.runId ? { runId: event.runId } : {}),
          type: event.type,
          payloadJson: event.payload,
          ...(event.provider ? { provider: event.provider } : {}),
          ...(event.model ? { model: event.model } : {}),
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
          // custo ausente ≠ zero: só grava quando reportado.
          ...(event.costUsd !== undefined ? { cost: String(event.costUsd) } : {}),
        })
        .returning({ id: usageEvents.id });
      return row!.id;
    },

    async updateCost(orgId: OrgId, id: string, costUsd: number): Promise<void> {
      await db
        .update(usageEvents)
        .set({ cost: String(costUsd) })
        .where(and(eq(usageEvents.id, id), eq(usageEvents.orgId, orgId)));
    },

    async summarize(orgId: OrgId, period: string): Promise<UsageSummary> {
      const { start, end } = periodRange(period);
      const rows = await db
        .select({
          type: usageEvents.type,
          total: sql<string | null>`sum(${usageEvents.cost})`,
        })
        .from(usageEvents)
        .where(and(eq(usageEvents.orgId, orgId), gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)))
        .groupBy(usageEvents.type);

      const byType: Record<string, number> = {};
      let totalCostUsd = 0;
      for (const r of rows) {
        const cost = r.total === null ? 0 : Number(r.total);
        byType[r.type] = cost;
        totalCostUsd += cost;
      }
      return { orgId, period, totalCostUsd, byType };
    },

    async llmCostInPeriod(orgId: OrgId, period: string): Promise<number> {
      const { start, end } = periodRange(period);
      const [row] = await db
        .select({ total: sql<string | null>`sum(${usageEvents.cost})` })
        .from(usageEvents)
        .where(and(eq(usageEvents.orgId, orgId), gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)));
      return row?.total === null || row?.total === undefined ? 0 : Number(row.total);
    },
  };
}
