import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { MetaGraphClient } from "./client.js";
import { MetaGovernor } from "./governor.js";
import { MetaBehaviorCatalogService } from "./behavior-catalog.js";

class FakeRedis {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }
  async pttl(): Promise<number> {
    return -1;
  }
}

const governor = new MetaGovernor({ redis: new FakeRedis() as unknown as Redis, rng: () => 0 });
const account = { adAccountId: "123", accessToken: "tok" };

function stub(body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", spy);
  return spy;
}
afterEach(() => vi.unstubAllGlobals());

const CATALOG = {
  data: [
    { id: "1", name: "Compradores online", path: ["Compras", "Compradores online"], audience_size_lower_bound: 1000 },
    { id: "2", name: "Viajantes frequentes", path: ["Viagem", "Viajantes frequentes"] },
    { id: "3", name: "Administradores de página do Facebook", path: ["Atividades digitais"] },
  ],
};

describe("MetaBehaviorCatalogService", () => {
  function svc(opts?: { redis?: Redis; ttlSec?: number }) {
    return new MetaBehaviorCatalogService(new MetaGraphClient({ graphVersion: "v26.0" }), governor, opts);
  }

  it("busca por texto = filtro LOCAL (substring normalizado, sem acento)", async () => {
    stub(CATALOG);
    const r = await svc().search(account, "viajante");
    expect(r.map((b) => b.name)).toEqual(["Viajantes frequentes"]);
  });

  it("filtra também pelo path (hierarquia)", async () => {
    stub(CATALOG);
    const r = await svc().search(account, "compras");
    expect(r.map((b) => b.id)).toContain("1");
  });

  it("query vazia → [] (sem chamada à Meta)", async () => {
    const spy = stub(CATALOG);
    expect(await svc().search(account, "  ")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("cache Redis: 2ª chamada NÃO refaz o fetch (locale-scoped)", async () => {
    const spy = stub(CATALOG);
    const redis = new FakeRedis() as unknown as Redis;
    const s = svc({ redis, ttlSec: 3600 });
    await s.search(account, "viajante");
    await s.search(account, "compras");
    expect(spy).toHaveBeenCalledTimes(1); // segunda leu do cache
  });
});
