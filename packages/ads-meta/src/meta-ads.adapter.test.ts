import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaAdsAdapter } from "./meta-ads.adapter.js";
import { MetaGraphClient } from "./client.js";
import { AdsPlatformError } from "@trafego/shared/ports";
import type { MetaGovernor } from "./governor.js";

// O governor não é usado nos fluxos de onboarding (sem governor.acquire) — stub vazio.
const governor = {} as unknown as MetaGovernor;

function makeAdapter(): MetaAdsAdapter {
  const client = new MetaGraphClient({ graphVersion: "v26.0" });
  return new MetaAdsAdapter({ client, governor });
}

interface StubbedResponse {
  readonly body: unknown;
  readonly status?: number;
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
      headers: { "content-type": "application/json" },
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

  it("rate-limit da Meta (HTTP 400) → upstream, não not_accessible", async () => {
    stubFetchSequence([{ body: { error: { message: "rate limit", code: 17 } }, status: 400 }]);
    await expect(makeAdapter().getAdAccount("tok", "1")).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "upstream",
    });
  });
});
