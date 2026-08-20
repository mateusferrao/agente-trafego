import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { callWithGovernor } from "./call-with-governor.js";
import { MetaGovernor } from "./governor.js";
import { MetaApiError, type GraphResponse } from "./client.js";

// Redis in-memory mínimo (set EX, pttl) — igual ao usado no governor.test.
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  async set(key: string, value: string, mode?: string, ttlSec?: number): Promise<"OK"> {
    const expiresAt = mode === "EX" && ttlSec ? Date.now() + ttlSec * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }
  async pttl(key: string): Promise<number> {
    const e = this.store.get(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    const ms = e.expiresAt - Date.now();
    return ms > 0 ? ms : -2;
  }
}

function makeGovernor() {
  const redis = new FakeRedis() as unknown as Redis;
  return new MetaGovernor({ redis, rng: () => 0 }); // rng 0 → backoff determinístico = 0ms
}

function ok<T>(data: T, usage?: GraphResponse<T>["usage"]): GraphResponse<T> {
  return usage ? { data, usage } : { data };
}

const ACCT = "act_1";

describe("callWithGovernor", () => {
  it("sucesso: retorna data e alimenta observeUsage (governor aprende)", async () => {
    const gov = makeGovernor();
    const spy = vi.spyOn(gov, "observeUsage");
    const data = await callWithGovernor(
      ACCT,
      async () => ok({ hi: 1 }, { [ACCT]: { callCountPct: 40, totalCputimePct: 10, totalTimePct: 10 } }),
      { governor: gov },
    );
    expect(data).toEqual({ hi: 1 });
    expect(spy).toHaveBeenCalledWith(ACCT, expect.objectContaining({ callCountPct: 40 }));
  });

  it("1º rate-limit (code 17) → retry inline curto → sucesso", async () => {
    const gov = makeGovernor();
    const sleepFn = vi.fn(async () => {});
    let calls = 0;
    const data = await callWithGovernor(
      ACCT,
      async () => {
        calls++;
        if (calls === 1) throw new MetaApiError("user request limit reached", 17, undefined, 400);
        return ok({ ok: true });
      },
      { governor: gov, sleepFn },
    );
    expect(data).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sleepFn).toHaveBeenCalledTimes(1); // um backoff entre as tentativas
  });

  it("rate-limit persistente → esgota maxRetries → relança (vira parcial na casca)", async () => {
    const gov = makeGovernor();
    const sleepFn = vi.fn(async () => {});
    let calls = 0;
    await expect(
      callWithGovernor(
        ACCT,
        async () => {
          calls++;
          throw new MetaApiError("throttled", 17, undefined, 400);
        },
        { governor: gov, sleepFn, maxRetries: 2 },
      ),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toBe(3); // tentativa inicial + 2 retries
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("cooldown ativo (longo) → degrada na hora, sem chamar fn", async () => {
    const gov = makeGovernor();
    await gov.observeUsage(ACCT, {
      callCountPct: 100,
      totalCputimePct: 50,
      totalTimePct: 50,
      estimatedTimeToRegainAccessMin: 5,
    });
    const fn = vi.fn(async () => ok({ never: true }));
    await expect(callWithGovernor(ACCT, fn, { governor: gov })).rejects.toBeInstanceOf(MetaApiError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("erro não-rate-limit (code 100) → relança na hora, sem retry", async () => {
    const gov = makeGovernor();
    const sleepFn = vi.fn(async () => {});
    let calls = 0;
    await expect(
      callWithGovernor(
        ACCT,
        async () => {
          calls++;
          throw new MetaApiError("bad", 100, undefined, 400);
        },
        { governor: gov, sleepFn },
      ),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toBe(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
