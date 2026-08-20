import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { MAX_INLINE_WAIT_MS, MetaGovernor, shouldDegrade } from "./governor.js";

// Redis in-memory mínimo (só o que o governor usa: set EX, pttl).
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

function makeGovernor(rng: () => number = Math.random) {
  const redis = new FakeRedis() as unknown as Redis;
  return new MetaGovernor({ redis, rng });
}

describe("MetaGovernor.backoffDelayMs", () => {
  it("full-jitter determinístico (rng injetado): floor(rng * min(cap, base·2^n))", () => {
    const gov = makeGovernor(() => 0.5);
    expect(gov.backoffDelayMs(0)).toBe(250); // 0.5 * 500
    expect(gov.backoffDelayMs(3)).toBe(2000); // 0.5 * (500 * 8)
  });

  it("clampa no teto p/ tentativas altas", () => {
    const gov = makeGovernor(() => 1); // ~ topo da janela
    expect(gov.backoffDelayMs(100)).toBe(60_000); // BACKOFF_CAP_MS
  });
});

describe("MetaGovernor.observeUsage + acquire", () => {
  it("Meta sinaliza throttle (min>0) → cooldown; acquire nega com degrade (TTL = min·60)", async () => {
    const gov = makeGovernor();
    await gov.observeUsage("act_1", {
      callCountPct: 95,
      totalCputimePct: 20,
      totalTimePct: 20,
      estimatedTimeToRegainAccessMin: 5,
    });
    const res = await gov.acquire("act_1");
    expect(res.granted).toBe(false);
    expect(res.degrade).toBe(true);
    // 5 min × 60 = 300s = ~300_000ms (prova a conversão min→seg)
    expect(res.retryAfterMs).toBeGreaterThan(299_000);
    expect(res.retryAfterMs).toBeLessThanOrEqual(300_000);
  });

  it("uso alto (95%) SEM sinal de throttle da Meta → NÃO faz cooldown (sem degradação prematura)", async () => {
    const gov = makeGovernor();
    await gov.observeUsage("act_hot", { callCountPct: 95, totalCputimePct: 30, totalTimePct: 30 });
    const res = await gov.acquire("act_hot");
    expect(res.granted).toBe(true);
    expect(res.degrade).toBe(false);
  });

  it("uso saturado (100%) → cooldown mesmo sem tempo reportado (default)", async () => {
    const gov = makeGovernor();
    await gov.observeUsage("act_max", { callCountPct: 100, totalCputimePct: 40, totalTimePct: 40 });
    const res = await gov.acquire("act_max");
    expect(res.granted).toBe(false);
    expect(res.degrade).toBe(true);
  });

  it("uso baixo → sem cooldown → acquire concede", async () => {
    const gov = makeGovernor();
    await gov.observeUsage("act_2", { callCountPct: 10, totalCputimePct: 10, totalTimePct: 10 });
    const res = await gov.acquire("act_2");
    expect(res.granted).toBe(true);
    expect(res.degrade).toBe(false);
    expect(res.retryAfterMs).toBe(0);
  });

  it("conta sem uso observado → acquire concede (pass-through)", async () => {
    const gov = makeGovernor();
    const res = await gov.acquire("act_never_seen");
    expect(res.granted).toBe(true);
  });
});

describe("shouldDegrade", () => {
  it("sem estimativa (undefined) → não degrada (1º hit transitório vale retry curto)", () => {
    expect(shouldDegrade(undefined)).toBe(false);
  });

  it("cooldown longo (acima do teto inline) → degrada (não segura o run por minutos)", () => {
    expect(shouldDegrade(MAX_INLINE_WAIT_MS + 1)).toBe(true);
    expect(shouldDegrade(5 * 60_000)).toBe(true); // 5 min
  });

  it("espera curta (dentro do teto) → não degrada (dá p/ retry inline)", () => {
    expect(shouldDegrade(MAX_INLINE_WAIT_MS)).toBe(false);
    expect(shouldDegrade(0)).toBe(false);
  });
});

describe("MetaGovernor.chunkForBatch", () => {
  it("particiona em lotes de ≤ size", () => {
    const gov = makeGovernor();
    const items = Array.from({ length: 120 }, (_, i) => i);
    const chunks = gov.chunkForBatch(items, 50);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
  });
});
