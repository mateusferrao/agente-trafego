import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { MetaAdsAdapter } from "./meta-ads.adapter.js";
import { MetaGraphClient } from "./client.js";
import { AdsPlatformError } from "@trafego/shared/ports";
import { MetaGovernor } from "./governor.js";

// O governor não é usado nos fluxos de onboarding (sem governor.acquire) — stub vazio.
const governor = {} as unknown as MetaGovernor;

function makeAdapter(): MetaAdsAdapter {
  const client = new MetaGraphClient({ graphVersion: "v26.0" });
  return new MetaAdsAdapter({ client, governor });
}

// Redis in-memory mínimo (set EX, pttl) p/ os fluxos que passam pelo governor.
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

// Adapter com governor real (rng 0 → backoff 0ms, sem flakiness) p/ testar rate-limit.
function makeAdapterWithGov(): { adapter: MetaAdsAdapter; gov: MetaGovernor } {
  const client = new MetaGraphClient({ graphVersion: "v26.0" });
  const gov = new MetaGovernor({ redis: new FakeRedis() as unknown as Redis, rng: () => 0 });
  return { adapter: new MetaAdsAdapter({ client, governor: gov }), gov };
}

interface StubbedResponse {
  readonly body: unknown;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

function stubFetchSequence(responses: readonly StubbedResponse[]) {
  const calls: string[] = [];
  let i = 0;
  const spy = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  });
  vi.stubGlobal("fetch", spy);
  return { calls: () => calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("MetaAdsAdapter.listAccessibleAccounts", () => {
  it("agrega páginas e mapeia account_id/currency/business", async () => {
    const { calls } = stubFetchSequence([
      {
        body: {
          data: [{ account_id: "1", name: "Conta A", currency: "BRL", business: { id: "b1" } }],
          paging: { next: "https://graph.facebook.com/next", cursors: { after: "CURSOR2" } },
        },
      },
      { body: { data: [{ account_id: "2", name: "Conta B", currency: "USD" }], paging: {} } },
    ]);

    const accounts = await makeAdapter().listAccessibleAccounts("tok");

    expect(accounts).toEqual([
      { id: "1", name: "Conta A", currency: "BRL", businessId: "b1" },
      { id: "2", name: "Conta B", currency: "USD" },
    ]);
    // segunda chamada usa o cursor `after` da primeira página.
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toContain("after=CURSOR2");
  });

  it("uma página só (sem paging.next) → uma chamada", async () => {
    const { calls } = stubFetchSequence([{ body: { data: [{ account_id: "9", name: "X" }] } }]);
    const accounts = await makeAdapter().listAccessibleAccounts("tok");
    expect(accounts).toEqual([{ id: "9", name: "X" }]);
    expect(calls()).toHaveLength(1);
  });
});

describe("MetaAdsAdapter.getAdAccount", () => {
  it("busca uma conta pelo id (prefixa act_) e mapeia", async () => {
    const { calls } = stubFetchSequence([
      { body: { account_id: "123", name: "Conta X", currency: "BRL", business: { id: "b9" } } },
    ]);
    const account = await makeAdapter().getAdAccount("tok", "123");
    expect(account).toEqual({ id: "123", name: "Conta X", currency: "BRL", businessId: "b9" });
    expect(calls()[0]).toContain("act_123");
  });

  it("token sem posse da conta → AdsPlatformError (not_accessible)", async () => {
    stubFetchSequence([{ body: { error: { message: "não autorizado", code: 100 } }, status: 400 }]);
    await expect(makeAdapter().getAdAccount("tok", "999")).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "not_accessible",
    });
    stubFetchSequence([{ body: { error: { message: "x", code: 100 } }, status: 400 }]);
    await expect(makeAdapter().getAdAccount("tok", "999")).rejects.toBeInstanceOf(AdsPlatformError);
  });

  it("rate-limit da Meta (code 17, HTTP 400) → rate_limited, não not_accessible", async () => {
    stubFetchSequence([{ body: { error: { message: "rate limit", code: 17 } }, status: 400 }]);
    await expect(makeAdapter().getAdAccount("tok", "1")).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "rate_limited",
    });
  });
});

describe("MetaAdsAdapter.listEntities (governor)", () => {
  const ref = { adAccountId: "1", accessToken: "tok" };
  const usageHeader = JSON.stringify({ act_1: [{ call_count: 30, total_cputime: 10, total_time: 10 }] });

  it("rate-limit transitório (code 17) → retry inline → completa", async () => {
    const { calls } = stubFetchSequence([
      { body: { error: { message: "throttled", code: 17 } }, status: 400 },
      { body: { data: [{ id: "c1", name: "Camp", status: "ACTIVE", objective: "OUTCOME_SALES" }] } },
    ]);
    const { adapter } = makeAdapterWithGov();
    const entities = await adapter.listEntities(ref, "campaign");
    expect(entities.map((e) => e.id)).toEqual(["c1"]);
    expect(calls().length).toBe(2); // 1ª falhou (rate-limit), retry completou
  });

  it("cooldown ativo → degrada (rate_limited) sem bater na Meta", async () => {
    const { adapter, gov } = makeAdapterWithGov();
    await gov.observeUsage("act_1", {
      callCountPct: 100,
      totalCputimePct: 50,
      totalTimePct: 50,
      estimatedTimeToRegainAccessMin: 5,
    });
    const { calls } = stubFetchSequence([{ body: { data: [] } }]);
    await expect(adapter.listEntities(ref, "campaign")).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "rate_limited",
    });
    expect(calls().length).toBe(0); // cooldown → nem chega a chamar fetch
  });

  it("sucesso alimenta o governor (observeUsage do header BUC)", async () => {
    const { adapter, gov } = makeAdapterWithGov();
    const spy = vi.spyOn(gov, "observeUsage");
    stubFetchSequence([
      {
        body: { data: [{ id: "c1", name: "Camp", status: "ACTIVE", objective: "OUTCOME_SALES" }] },
        headers: { "x-business-use-case-usage": usageHeader },
      },
    ]);
    await adapter.listEntities(ref, "campaign");
    expect(spy).toHaveBeenCalledWith("act_1", expect.objectContaining({ callCountPct: 30 }));
  });
});
