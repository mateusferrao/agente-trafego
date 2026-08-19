import { describe, expect, it, vi } from "vitest";
import { createRunReaper } from "./run-reaper.js";

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never;

/** DB fake: captura o filtro do update e devolve as linhas reapadas. */
function fakeDb(reaped: { id: string }[]) {
  const calls: { set?: unknown } = {};
  const db = {
    update: () => ({
      set: (v: unknown) => {
        calls.set = v;
        return { where: () => ({ returning: async () => reaped }) };
      },
    }),
  };
  return { db, calls };
}

describe("createRunReaper.reapStale", () => {
  it("marca os runs presos como failed e retorna a contagem", async () => {
    const { db, calls } = fakeDb([{ id: "r1" }, { id: "r2" }]);
    const reaper = createRunReaper({ db: db as never, logger, staleMinutes: 30 });
    const count = await reaper.reapStale();
    expect(count).toBe(2);
    expect(calls.set).toMatchObject({ status: "failed" });
    expect((calls.set as { summary: string }).summary).toMatch(/interrompida/i);
  });

  it("nada preso → 0, sem ruído", async () => {
    const { db } = fakeDb([]);
    const reaper = createRunReaper({ db: db as never, logger, staleMinutes: 30 });
    expect(await reaper.reapStale()).toBe(0);
  });
});
