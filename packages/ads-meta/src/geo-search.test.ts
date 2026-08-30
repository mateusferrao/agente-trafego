import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { MetaGraphClient } from "./client.js";
import { MetaGeoSearchService } from "./geo-search.js";
import { MetaGovernor } from "./governor.js";

const account = { adAccountId: "act_123", accessToken: "tok" };
afterEach(() => vi.unstubAllGlobals());

class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  async set(key: string, value: string, mode?: string, ttlSec?: number): Promise<"OK"> {
    this.store.set(key, { value, expiresAt: mode === "EX" && ttlSec ? Date.now() + ttlSec * 1000 : null });
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
function svc() {
  const client = new MetaGraphClient({ graphVersion: "v26.0" });
  const governor = new MetaGovernor({ redis: new FakeRedis() as unknown as Redis, rng: () => 0 });
  return new MetaGeoSearchService(client, governor);
}

function stubResponse(body: Record<string, unknown>) {
  const calls: Array<{ url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      calls.push({ url: String(input) });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return { calls: () => calls };
}

describe("MetaGeoSearchService.search (Fase 1, subfatia 3a)", () => {
  it("query vazia → array vazio, ZERO chamada Graph", async () => {
    const { calls } = stubResponse({ data: [] });
    expect(await svc().search(account, "  ", ["city"])).toEqual([]);
    expect(calls()).toHaveLength(0);
  });

  it("locationTypes vazio → array vazio, ZERO chamada Graph", async () => {
    const { calls } = stubResponse({ data: [] });
    expect(await svc().search(account, "Belo Horizonte", [])).toEqual([]);
    expect(calls()).toHaveLength(0);
  });

  it("mapeia cidade/região/país da resposta cru, ignora tipos não suportados (ex: zip)", async () => {
    const { calls } = stubResponse({
      data: [
        { key: "2430536", name: "Belo Horizonte", type: "city", country_code: "BR" },
        { key: "3157", name: "Minas Gerais", type: "region" },
        { key: "BR", name: "Brasil", type: "country" },
        { key: "30130-000", name: "30130-000", type: "zip" },
      ],
    });
    const results = await svc().search(account, "Belo Horizonte", ["city", "region", "country"]);
    expect(results).toEqual([
      { key: "2430536", name: "Belo Horizonte", kind: "city", countryCode: "BR" },
      { key: "3157", name: "Minas Gerais", kind: "region" },
      { key: "BR", name: "Brasil", kind: "country" },
    ]);
    const url = calls()[0]!.url;
    expect(url).toContain("/search");
    expect(url).toContain("type=adgeolocation");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain("Belo Horizonte");
  });

  it("descarta itens sem key/name (resposta incompleta)", async () => {
    stubResponse({ data: [{ name: "Sem key", type: "city" }, { key: "1", type: "city" }] });
    expect(await svc().search(account, "x", ["city"])).toEqual([]);
  });
});
