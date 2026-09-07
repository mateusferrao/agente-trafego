import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { claimInbound } from "./inbound-dedupe.js";

describe("claimInbound (dedupe atômico via SET NX)", () => {
  it("1ª vez (SET NX = OK) → true (processa) + usa NX + TTL + chave por instância", async () => {
    const set = vi.fn(async (..._a: unknown[]): Promise<"OK" | null> => "OK");
    const ok = await claimInbound({ set } as unknown as Redis, "inst-1", "MSG-1");
    expect(ok).toBe(true);
    const args = set.mock.calls[0]!;
    expect(args[0]).toBe("wa:dedup:inst-1:MSG-1");
    expect(args).toContain("NX");
    expect(args).toContain("EX");
  });

  it("duplicata (SET NX = null, chave já existe) → false (ignora)", async () => {
    const set = vi.fn(async (..._a: unknown[]): Promise<"OK" | null> => null);
    expect(await claimInbound({ set } as unknown as Redis, "inst-1", "MSG-1")).toBe(false);
  });
});
