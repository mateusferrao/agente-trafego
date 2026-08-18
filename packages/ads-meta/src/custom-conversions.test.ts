import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { MetaGraphClient } from "./client.js";
import { CustomConversionsResolver } from "./custom-conversions.js";

class FakeRedis {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }
}

function makeResolver(pages: Array<{ data: unknown[]; paging?: unknown }>) {
  const request = vi.fn(async () => ({ data: pages.shift() ?? { data: [] } }));
  const client = { request } as unknown as MetaGraphClient;
  const redis = new FakeRedis();
  const resolver = new CustomConversionsResolver({ client, redis: redis as unknown as Redis, ttlSec: 3600 });
  return { resolver, request, redis };
}

const TOKEN = "tok";

describe("CustomConversionsResolver", () => {
  it("cache-miss → busca, cacheia e resolve nome + goal (via custom_event_type)", async () => {
    const { resolver, request, redis } = makeResolver([
      { data: [{ id: "111", name: "Compra do curso", custom_event_type: "PURCHASE" }] },
    ]);
    const map = await resolver.resolveMany("123", TOKEN, new Set(["111"]));
    expect(map.get("111")).toEqual({ name: "Compra do curso", goal: "purchase" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(redis.store.size).toBe(1); // cacheou
  });

  it("cache-hit → não busca de novo", async () => {
    const { resolver, request } = makeResolver([
      { data: [{ id: "111", name: "A", custom_event_type: "LEAD" }] },
    ]);
    await resolver.resolveMany("123", TOKEN, new Set(["111"]));
    await resolver.resolveMany("123", TOKEN, new Set(["111"]));
    expect(request).toHaveBeenCalledTimes(1); // segunda vez veio do cache
  });

  it("lookup-miss (id novo fora do cache) → refresh 1×", async () => {
    const { resolver, request } = makeResolver([
      { data: [{ id: "111", name: "A", custom_event_type: "LEAD" }] }, // 1ª busca
      { data: [
        { id: "111", name: "A", custom_event_type: "LEAD" },
        { id: "222", name: "Order bump", custom_event_type: "PURCHASE" }, // criada depois
      ] },
    ]);
    await resolver.resolveMany("123", TOKEN, new Set(["111"])); // popula cache com {111}
    const map = await resolver.resolveMany("123", TOKEN, new Set(["222"])); // 222 falta → refresh
    expect(map.get("222")).toEqual({ name: "Order bump", goal: "purchase" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("falha da API → mapa vazio (degrada; math não quebra)", async () => {
    const request = vi.fn(async () => {
      throw new Error("boom");
    });
    const client = { request } as unknown as MetaGraphClient;
    const redis = new FakeRedis() as unknown as Redis;
    const resolver = new CustomConversionsResolver({ client, redis, ttlSec: 3600 });
    const map = await resolver.resolveMany("123", TOKEN, new Set(["111"]));
    expect(map.size).toBe(0);
  });
});
