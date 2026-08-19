import { describe, expect, it, vi } from "vitest";
import { AGENT_RUNS_QUEUE } from "@trafego/shared";
import { createRunDispatcher } from "./run-dispatcher.js";

/**
 * DB falso: cada select/insert consome o próximo resultado da fila, na ordem em
 * que o dispatcher consulta (status → cap → gasto → insert).
 */
function fakeDb(results: unknown[]) {
  let i = 0;
  const arr = () => Promise.resolve(results[i++]);
  const whereObj = {
    limit: () => arr(),
    then: (res: (v: unknown) => unknown) => arr().then(res),
  };
  return {
    select: () => ({ from: () => ({ where: () => whereObj }) }),
    insert: () => ({ values: () => ({ returning: () => arr() }) }),
  } as never;
}

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
const INPUT = { orgId: "org-1", agentId: "ag-1", adAccountId: "acc-1" };

function makeScheduler() {
  return {
    enqueue: vi.fn(
      async (_job: { queue: string; name: string; payload: Record<string, unknown>; idempotencyKey?: string }) =>
        undefined,
    ),
    upsertSchedule: vi.fn(),
    removeSchedule: vi.fn(),
  };
}

describe("createRunDispatcher.dispatch", () => {
  it("agente pausado → skipped_paused, sem enfileirar", async () => {
    const scheduler = makeScheduler();
    const dispatcher = createRunDispatcher({
      db: fakeDb([[{ status: "paused" }]]),
      scheduler: scheduler as never,
      logger,
      envCostCapUsd: 0,
    });
    expect(await dispatcher.dispatch(INPUT)).toBe("skipped_paused");
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it("cap de custo atingido → skipped_cost_cap, sem enfileirar", async () => {
    const scheduler = makeScheduler();
    const dispatcher = createRunDispatcher({
      db: fakeDb([[{ status: "active" }], [{ cap: "10" }], [{ total: "20" }]]),
      scheduler: scheduler as never,
      logger,
      envCostCapUsd: 0,
    });
    expect(await dispatcher.dispatch(INPUT)).toBe("skipped_cost_cap");
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it("caminho feliz → cria run e enfileira execute", async () => {
    const scheduler = makeScheduler();
    const dispatcher = createRunDispatcher({
      db: fakeDb([[{ status: "active" }], [{ cap: null }], [{ total: null }], [{ id: "run-9" }]]),
      scheduler: scheduler as never,
      logger,
      envCostCapUsd: 0,
    });
    expect(await dispatcher.dispatch(INPUT)).toBe("enqueued");
    expect(scheduler.enqueue).toHaveBeenCalledOnce();
    const job = scheduler.enqueue.mock.calls[0]![0];
    expect(job.queue).toBe(AGENT_RUNS_QUEUE);
    expect(job.idempotencyKey).toBe("run-9");
    expect(job.payload).toMatchObject({ mode: "execute", trigger: "cron", runId: "run-9", adAccountId: "acc-1" });
  });
});
