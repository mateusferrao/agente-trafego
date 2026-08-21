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
  // innerJoin encadeável (a query do gate faz 2 innerJoins: memberships→users→access_grants).
  const chain: { innerJoin: () => typeof chain; where: () => typeof whereObj } = {
    innerJoin: () => chain,
    where: () => whereObj,
  };
  return {
    select: () => ({ from: () => chain }),
    insert: () => ({ values: () => ({ returning: () => arr() }) }),
  } as never;
}

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
const INPUT = { orgId: "org-1", agentId: "ag-1", adAccountId: "acc-1" };

/** Metering fake: o gasto do período vem do ledger (não mais de cost_snapshot). */
function makeMetering(spent: number) {
  return { llmCostInPeriod: vi.fn(async () => spent), record: vi.fn(), summarize: vi.fn() } as never;
}

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
      db: fakeDb([[{ agentStatus: "paused", accountStatus: "active" }]]),
      scheduler: scheduler as never,
      logger,
      metering: makeMetering(0),
      envCostCapUsd: 0,
    });
    expect(await dispatcher.dispatch(INPUT)).toBe("skipped_paused");
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it("conta fora de gestão (unavailable/removed) → skipped_inactive_account", async () => {
    const scheduler = makeScheduler();
    const dispatcher = createRunDispatcher({
      db: fakeDb([[{ agentStatus: "active", accountStatus: "unavailable" }]]),
      scheduler: scheduler as never,
      logger,
      metering: makeMetering(0),
      envCostCapUsd: 0,
    });
    expect(await dispatcher.dispatch(INPUT)).toBe("skipped_inactive_account");
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it("org sem acesso liberado (beta gate) → skipped_access, sem enfileirar", async () => {
    const scheduler = makeScheduler();
    const dispatcher = createRunDispatcher({
      // status ok → owner grant pending → gate barra.
      db: fakeDb([[{ agentStatus: "active", accountStatus: "active" }], [{ status: "pending" }]]),
      scheduler: scheduler as never,
      logger,
      metering: makeMetering(0),
      envCostCapUsd: 0,
    });
    expect(await dispatcher.dispatch(INPUT)).toBe("skipped_access");
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it("cap de custo atingido → skipped_cost_cap, sem enfileirar", async () => {
    const scheduler = makeScheduler();
    const dispatcher = createRunDispatcher({
      // status ok → owner active → cap.
      db: fakeDb([
        [{ agentStatus: "active", accountStatus: "active" }],
        [{ status: "active" }],
        [{ cap: "10" }],
      ]),
      scheduler: scheduler as never,
      logger,
      metering: makeMetering(20), // ledger: gasto 20 ≥ cap 10
      envCostCapUsd: 0,
    });
    expect(await dispatcher.dispatch(INPUT)).toBe("skipped_cost_cap");
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it("caminho feliz → cria run e enfileira execute", async () => {
    const scheduler = makeScheduler();
    const dispatcher = createRunDispatcher({
      db: fakeDb([
        [{ agentStatus: "active", accountStatus: "active" }],
        [{ status: "active" }],
        [{ cap: null }],
        [{ id: "run-9" }],
      ]),
      scheduler: scheduler as never,
      logger,
      metering: makeMetering(0),
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
