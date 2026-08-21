import { describe, expect, it, vi } from "vitest";
import { createDashboardService } from "./service.js";

/** DB fake: cada `.select()` consome o próximo resultado da fila (na ordem das queries). */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  const next = () => queue[i++] ?? [];
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    where: () => {
      const r = next();
      const p = Promise.resolve(r) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
      p.limit = async () => r;
      return p;
    },
  };
  return chain as never;
}

const NOW = () => new Date("2026-08-20T12:00:00Z");

function acctSnap(date: string, spend: number, purchases: number) {
  return {
    entityLevel: "account",
    entityId: "ACT1",
    date,
    metricsJson: {
      metrics: { spend, impressions: 1000, clicks: 20, ctr: 0, cpc: 0, cpm: 0 },
      conversions: [{ goal: "purchase", count: purchases, value: spend * 4 }],
    },
  };
}

describe("createDashboardService.liveMetrics", () => {
  it("computa KPIs ao vivo + as-of da conta (org-scoped)", async () => {
    const syncedAt = new Date("2026-08-20T11:30:00Z");
    const db = fakeDb([
      [{ currency: "BRL" }], // account
      [{ goals: { conversionGoal: "purchase" } }], // agent
      [acctSnap("2026-08-19", 100, 5), acctSnap("2026-08-20", 100, 5)], // snapshots (janela)
      [{ latest: syncedAt }], // max(updated_at)
    ]);
    const service = createDashboardService({ db, scheduler: {} as never, windowDays: 7, baselineDays: 7, now: NOW });

    const out = await service.liveMetrics("org-1" as never, "acc-1");
    expect(out.currency).toBe("BRL");
    expect(out.asOf).toBe(syncedAt.toISOString());
    expect(out.window).toEqual({ since: "2026-08-14", until: "2026-08-20" });
    expect(out.totals).not.toBeNull();
    expect(out.totals!.spend).toBe(200);
    expect(out.totals!.cpa).toBeCloseTo(20); // 200 / 10 compras
  });

  it("conta inexistente → 404", async () => {
    const db = fakeDb([[]]); // account vazio
    const service = createDashboardService({ db, scheduler: {} as never, windowDays: 7, baselineDays: 7, now: NOW });
    await expect(service.liveMetrics("org-1" as never, "nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("createDashboardService.requestRefresh", () => {
  it("enfileira o sync-only da conta", async () => {
    const enqueue = vi.fn(async () => {});
    const db = fakeDb([[{ id: "acc-1" }]]);
    const service = createDashboardService({
      db,
      scheduler: { enqueue } as never,
      windowDays: 7,
      baselineDays: 7,
      now: NOW,
    });
    const out = await service.requestRefresh("org-1" as never, "acc-1");
    expect(out).toEqual({ enqueued: true });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "insights-sync-run", idempotencyKey: "sync:acc-1" }),
    );
  });

  it("conta inexistente → 404 (não enfileira)", async () => {
    const enqueue = vi.fn(async () => {});
    const db = fakeDb([[]]);
    const service = createDashboardService({
      db,
      scheduler: { enqueue } as never,
      windowDays: 7,
      baselineDays: 7,
      now: NOW,
    });
    await expect(service.requestRefresh("org-1" as never, "nope")).rejects.toMatchObject({ statusCode: 404 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
