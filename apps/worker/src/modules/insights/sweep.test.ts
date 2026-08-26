import { describe, expect, it, vi } from "vitest";
import { createInsightsSweep } from "./sweep.js";
import type { InsightsSnapshotsRepo } from "./repo.js";

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
const NOW = Date.UTC(2026, 7, 18, 14, 0, 0);
const MIN = 60_000;

/** DB fake: o chain select→from→innerJoin→where resolve nas contas ativas. */
function fakeDb(rows: { orgId: string; accountId: string }[]) {
  return {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => rows }) }) }),
  } as never;
}

function fakeRepo(latest: Record<string, Date>): InsightsSnapshotsRepo {
  return {
    latestSyncedAtByAccounts: async () => new Map(Object.entries(latest)),
  } as never;
}

function fakeScheduler() {
  const enqueued: unknown[] = [];
  return { scheduler: { enqueue: async (j: unknown) => void enqueued.push(j) } as never, enqueued };
}

describe("createInsightsSweep.sweep", () => {
  it("enfileira sync-only só p/ as contas velhas (fresca pula)", async () => {
    const { scheduler, enqueued } = fakeScheduler();
    const sweep = createInsightsSweep({
      db: fakeDb([
        { orgId: "o1", accountId: "velha" },
        { orgId: "o1", accountId: "fresca" },
      ]),
      repo: fakeRepo({
        velha: new Date(NOW - 200 * MIN), // > 120 → sync
        fresca: new Date(NOW - 30 * MIN), // < 120 → pula
      }),
      scheduler,
      logger,
      thresholdMin: 120,
      dormantThresholdMin: 1440,
      now: () => NOW,
      staggerWindowMs: 60_000,
    });

    const res = await sweep.sweep();
    expect(res).toEqual({ scanned: 2, enqueued: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      name: "insights-sync-run",
      payload: { accountId: "velha", orgId: "o1", trigger: "cron" },
      idempotencyKey: "sync-velha",
      delayMs: 0,
    });
  });

  it("conta sem snapshot (nunca sincronizada) → enfileira", async () => {
    const { scheduler, enqueued } = fakeScheduler();
    const sweep = createInsightsSweep({
      db: fakeDb([{ orgId: "o1", accountId: "nova" }]),
      repo: fakeRepo({}), // sem entrada → latest null → shouldSync true
      scheduler,
      logger,
      thresholdMin: 120,
      dormantThresholdMin: 1440,
      now: () => NOW,
      staggerWindowMs: 60_000,
    });
    const res = await sweep.sweep();
    expect(res).toEqual({ scanned: 1, enqueued: 1 });
    expect(enqueued).toHaveLength(1);
  });

  it("espalha os enqueues no stagger (delay crescente)", async () => {
    const { scheduler, enqueued } = fakeScheduler();
    const sweep = createInsightsSweep({
      db: fakeDb([
        { orgId: "o1", accountId: "a" },
        { orgId: "o1", accountId: "b" },
      ]),
      repo: fakeRepo({}), // ambas velhas (null)
      scheduler,
      logger,
      thresholdMin: 120,
      dormantThresholdMin: 1440,
      now: () => NOW,
      staggerWindowMs: 60_000,
    });
    await sweep.sweep();
    expect((enqueued[0] as { delayMs: number }).delayMs).toBe(0);
    expect((enqueued[1] as { delayMs: number }).delayMs).toBe(30_000); // floor(60000/2)
  });

  it("nenhuma conta ativa → 0, sem enqueue", async () => {
    const { scheduler, enqueued } = fakeScheduler();
    const sweep = createInsightsSweep({
      db: fakeDb([]),
      repo: fakeRepo({}),
      scheduler,
      logger,
      thresholdMin: 120,
      dormantThresholdMin: 1440,
      now: () => NOW,
      staggerWindowMs: 60_000,
    });
    expect(await sweep.sweep()).toEqual({ scanned: 0, enqueued: 0 });
    expect(enqueued).toHaveLength(0);
  });
});
