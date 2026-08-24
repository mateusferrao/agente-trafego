import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import { createNotifyRepo } from "./repo.js";

describe("purgeGroupMessagesBefore (retenção do contexto de grupo, S7)", () => {
  it("devolve o nº de linhas apagadas (delete .. where created_at < cutoff)", async () => {
    const returning = vi.fn(async () => [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const where = vi.fn(() => ({ returning }));
    const del = vi.fn(() => ({ where }));
    const db = { delete: del } as unknown as Database;

    const count = await createNotifyRepo(db).purgeGroupMessagesBefore(new Date("2026-05-01T00:00:00Z"));

    expect(count).toBe(3);
    expect(del).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
  });
});
