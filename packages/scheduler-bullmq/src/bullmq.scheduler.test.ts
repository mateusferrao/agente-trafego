import { beforeEach, describe, expect, it, vi } from "vitest";

const addSpy = vi.fn();
const upsertSchedulerSpy = vi.fn();
const QueueMock = vi.fn(() => ({
  add: addSpy,
  upsertJobScheduler: upsertSchedulerSpy,
  removeJobScheduler: vi.fn(),
  close: vi.fn(),
}));

vi.mock("bullmq", () => ({ Queue: QueueMock }));

// Importado após o mock (bullmq é resolvido pelo mock acima).
const { BullmqScheduler, stableOffset } = await import("./bullmq.scheduler.js");

const CONNECTION = { host: "localhost", port: 6379 };

beforeEach(() => {
  addSpy.mockClear();
  QueueMock.mockClear();
});

describe("BullmqScheduler.enqueue", () => {
  it("cria a Queue pelo nome e chama add(name, payload)", async () => {
    const scheduler = new BullmqScheduler(CONNECTION);
    await scheduler.enqueue({ queue: "agent-runs", name: "analysis-run", payload: { accountId: "a1" } });

    expect(QueueMock).toHaveBeenCalledWith("agent-runs", { connection: CONNECTION });
    expect(addSpy).toHaveBeenCalledWith("analysis-run", { accountId: "a1" }, undefined);
  });

  it("usa idempotencyKey como jobId quando presente", async () => {
    const scheduler = new BullmqScheduler(CONNECTION);
    await scheduler.enqueue({
      queue: "agent-runs",
      name: "analysis-run",
      payload: { accountId: "a1" },
      idempotencyKey: "run-42",
    });

    expect(addSpy).toHaveBeenCalledWith("analysis-run", { accountId: "a1" }, { jobId: "run-42" });
  });

  it("reusa a mesma Queue para o mesmo nome (não recria)", async () => {
    const scheduler = new BullmqScheduler(CONNECTION);
    await scheduler.enqueue({ queue: "agent-runs", name: "a", payload: {} });
    await scheduler.enqueue({ queue: "agent-runs", name: "b", payload: {} });

    expect(QueueMock).toHaveBeenCalledTimes(1);
  });
});

describe("BullmqScheduler.upsertSchedule", () => {
  beforeEach(() => upsertSchedulerSpy.mockClear());

  it("cria Job Scheduler com pattern cron + tz + offset estável", async () => {
    const scheduler = new BullmqScheduler(CONNECTION);
    await scheduler.upsertSchedule({
      key: "analysis:acc-1",
      queue: "agent-cron",
      cron: "0 8 * * *",
      tz: "America/Sao_Paulo",
      jitterMs: 300000,
      payload: { adAccountId: "acc-1" },
    });
    const [id, repeat, template] = upsertSchedulerSpy.mock.calls[0]!;
    expect(id).toBe("analysis:acc-1");
    expect(repeat).toMatchObject({ pattern: "0 8 * * *", tz: "America/Sao_Paulo" });
    expect(typeof (repeat as { offset: number }).offset).toBe("number");
    expect(template).toEqual({ name: "analysis:acc-1", data: { adAccountId: "acc-1" } });
  });
});

describe("stableOffset", () => {
  it("é determinístico e fica em [0, max)", () => {
    const a = stableOffset("analysis:acc-1", 1000);
    const b = stableOffset("analysis:acc-1", 1000);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1000);
  });

  it("keys diferentes tendem a offsets diferentes (stagger)", () => {
    expect(stableOffset("analysis:acc-1", 100000)).not.toBe(stableOffset("analysis:acc-2", 100000));
  });

  it("max 0 → offset 0", () => {
    expect(stableOffset("k", 0)).toBe(0);
  });
});
