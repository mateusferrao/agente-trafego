import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { MetaGraphClient } from "./client.js";
import { MetaInterestSearchService } from "./interest-search.js";
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
  return new MetaInterestSearchService(client, governor);
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

describe("MetaInterestSearchService.search (Fase 2, subfatia 4)", () => {
  it("query vazia → array vazio, ZERO chamada Graph", async () => {
    const { calls } = stubResponse({ data: [] });
    expect(await svc().search(account, "  ")).toEqual([]);
    expect(calls()).toHaveLength(0);
  });

  it("mapeia interesses da resposta cru (id/name/audienceSize/path)", async () => {
    const { calls } = stubResponse({
      data: [
        { id: "i1", name: "Estética", audience_size_lower_bound: 1_500_000, path: ["Beleza", "Estética"] },
        { id: "i2", name: "Pets" },
      ],
    });
    const results = await svc().search(account, "estetica");
    expect(results).toEqual([
      { id: "i1", name: "Estética", audienceSize: 1_500_000, path: ["Beleza", "Estética"] },
      { id: "i2", name: "Pets" },
    ]);
    const url = calls()[0]!.url;
    expect(url).toContain("/search");
    expect(url).toContain("type=adinterest");
  });

  it("descarta itens sem id/name (resposta incompleta)", async () => {
    stubResponse({ data: [{ name: "Sem id" }, { id: "i1" }] });
    expect(await svc().search(account, "x")).toEqual([]);
  });
});
