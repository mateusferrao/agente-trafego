import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { MetaAudiencesService } from "./audiences.js";
import { MetaGraphClient } from "./client.js";
import { MetaGovernor } from "./governor.js";

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

const account = { adAccountId: "123", accessToken: "tok" };

function stubGet(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
  );
}
afterEach(() => vi.unstubAllGlobals());

function makeService(): MetaAudiencesService {
  const gov = new MetaGovernor({ redis: new FakeRedis() as unknown as Redis, rng: () => 0 });
  return new MetaAudiencesService(new MetaGraphClient({ graphVersion: "v26.0" }), gov);
}

describe("MetaAudiencesService.list", () => {
  it("normaliza subtype + detecta lookalike (por subtype E por nome)", async () => {
    stubGet({
      data: [
        { id: "A1", name: "Engajamento 90 dias", subtype: "ENGAGEMENT", approximate_count_lower_bound: 12000 },
        { id: "A2", name: "LAL 1% compradores", subtype: "LOOKALIKE" },
        { id: "A3", name: "Semelhantes - site", subtype: "CUSTOM" },
      ],
    });
    const list = await makeService().list(account);
    expect(list).toEqual([
      { id: "A1", name: "Engajamento 90 dias", subtype: "engagement", approximateCount: 12000, isLookalike: false },
      { id: "A2", name: "LAL 1% compradores", subtype: "lookalike", isLookalike: true },
      { id: "A3", name: "Semelhantes - site", subtype: "custom", isLookalike: true }, // nome "semelhante" → lookalike
    ]);
  });

  it("lista vazia → []", async () => {
    stubGet({ data: [] });
    expect(await makeService().list(account)).toEqual([]);
  });

  it("pula linha sem id", async () => {
    stubGet({ data: [{ name: "sem id" }, { id: "A9", name: "ok" }] });
    const list = await makeService().list(account);
    expect(list.map((a) => a.id)).toEqual(["A9"]);
  });
});
