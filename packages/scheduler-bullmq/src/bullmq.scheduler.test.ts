import { beforeEach, describe, expect, it, vi } from "vitest";

const addSpy = vi.fn();
const QueueMock = vi.fn(() => ({ add: addSpy, close: vi.fn() }));

vi.mock("bullmq", () => ({ Queue: QueueMock }));

// Importado após o mock (bullmq é resolvido pelo mock acima).
const { BullmqScheduler } = await import("./bullmq.scheduler.js");

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
