import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import type { AdEntity } from "@trafego/shared/types";
import { MetaEntityCache } from "./entity-cache.js";

class FakeRedis {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string) { this.store.set(k, v); return "OK" as const; }
  async del(...keys: string[]) { let n = 0; for (const k of keys) if (this.store.delete(k)) n++; return n; }
}

const ENT: AdEntity[] = [{ id: "c1", level: "campaign", name: "Camp", status: "active" }];

function make(ttlSec: number) {
  const redis = new FakeRedis();
  return { cache: new MetaEntityCache({ redis: redis as unknown as Redis, ttlSec }), redis };
}

describe("MetaEntityCache", () => {
  it("set → get devolve o catálogo (hit)", async () => {
    const { cache } = make(600);
    await cache.set("act_1", "campaign", ENT);
    expect(await cache.get("act_1", "campaign")).toEqual(ENT);
  });

  it("miss → null", async () => {
    const { cache } = make(600);
    expect(await cache.get("act_1", "adset")).toBeNull();
  });

  it("invalidate derruba todos os níveis da conta", async () => {
    const { cache } = make(600);
    await cache.set("act_1", "campaign", ENT);
    await cache.set("act_1", "adset", ENT);
    await cache.invalidate("act_1");
    expect(await cache.get("act_1", "campaign")).toBeNull();
    expect(await cache.get("act_1", "adset")).toBeNull();
  });

  it("ttl <= 0 desliga o cache (get sempre miss, set no-op)", async () => {
    const { cache, redis } = make(0);
    await cache.set("act_1", "campaign", ENT);
    expect(redis.store.size).toBe(0);
    expect(await cache.get("act_1", "campaign")).toBeNull();
    expect(cache.enabled).toBe(false);
  });

  it("JSON corrompido → miss (re-lista)", async () => {
    const { cache, redis } = make(600);
    redis.store.set("meta:entities:act_1:campaign", "{corrompido");
    expect(await cache.get("act_1", "campaign")).toBeNull();
  });
});
