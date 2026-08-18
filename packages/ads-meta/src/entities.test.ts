import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaGraphClient } from "./client.js";
import { MetaAdsAdapter } from "./meta-ads.adapter.js";
import type { MetaGovernor } from "./governor.js";
import type { CustomConversionsResolver } from "./custom-conversions.js";

const governor = {} as unknown as MetaGovernor;
const account = { adAccountId: "123", accessToken: "tok" };

function stub(body: unknown) {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

function makeAdapter(customConversions?: CustomConversionsResolver): MetaAdsAdapter {
  return new MetaAdsAdapter({
    client: new MetaGraphClient({ graphVersion: "v26.0" }),
    governor,
    ...(customConversions ? { customConversions } : {}),
  });
}

describe("MetaAdsAdapter.listEntities", () => {
  it("account não é edge listável → [] (sem chamada)", async () => {
    const spy = stub({ data: [] });
    expect(await makeAdapter().listEntities(account, "account")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("campaign: status (effective), budget ÷100, objetivo coarse", async () => {
    stub({
      data: [
        { id: "C1", name: "Camp", effective_status: "ACTIVE", daily_budget: "5000", objective: "OUTCOME_SALES" },
      ],
    });
    const [e] = await makeAdapter().listEntities(account, "campaign");
    expect(e).toMatchObject({
      id: "C1",
      level: "campaign",
      name: "Camp",
      status: "active",
      dailyBudget: 50,
      objective: { goal: "purchase" },
    });
  });

  it("adset com conversão personalizada → objetivo custom + label resolvido", async () => {
    stub({
      data: [
        {
          id: "AS1",
          name: "Set",
          effective_status: "PAUSED",
          campaign_id: "C1",
          optimization_goal: "OFFSITE_CONVERSIONS",
          promoted_object: { custom_conversion_id: "999" },
        },
      ],
    });
    const resolver = {
      resolveMany: async () => new Map([["999", { name: "Compra curso", goal: "purchase" }]]),
    } as unknown as CustomConversionsResolver;

    const [e] = await makeAdapter(resolver).listEntities(account, "adset");
    expect(e).toMatchObject({
      id: "AS1",
      level: "adset",
      status: "paused",
      parentId: "C1",
      objective: { goal: "custom", customConversionId: "999", label: "Compra curso" },
    });
  });

  it("ad → sem objetivo próprio (herda do adset no assemble), parentId = adset", async () => {
    stub({ data: [{ id: "AD1", name: "Ad", effective_status: "ACTIVE", adset_id: "AS1" }] });
    const [e] = await makeAdapter().listEntities(account, "ad");
    expect(e).toMatchObject({ id: "AD1", level: "ad", parentId: "AS1" });
    expect(e!.objective).toBeUndefined();
  });
});
