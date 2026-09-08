import { beforeEach, describe, expect, it, vi } from "vitest";
import { reapStaleCreatingDrafts } from "./draft-reaper.js";

const warn = vi.fn();
const logger = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never;

beforeEach(() => warn.mockClear());

/** DB fake: captura o `set` do update e devolve as linhas reapadas. */
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

describe("reapStaleCreatingDrafts", () => {
  it("marca os rascunhos presos em creating como failed e retorna a contagem", async () => {
    const { db, calls } = fakeDb([{ id: "d1" }, { id: "d2" }]);
    const count = await reapStaleCreatingDrafts(db as never, logger, 30);
    expect(count).toBe(2);
    expect(calls.set).toEqual({ status: "failed" }); // failed = retomável + libera o cap
  });

  it("nada preso → 0, sem ruído", async () => {
    const { db } = fakeDb([]);
    expect(await reapStaleCreatingDrafts(db as never, logger, 30)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
