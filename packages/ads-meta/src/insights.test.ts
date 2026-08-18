import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InsightsQuery } from "@trafego/shared/ports";
import { MetaGraphClient, MetaApiError } from "./client.js";
import { MetaInsightsService } from "./insights.js";

const GRAPH_VERSION = "v26.0";
const APP_SECRET = "app-secret-xyz";
const TOKEN = "SYSTEM-USER-TOKEN";

function makeQuery(): InsightsQuery {
  return {
    account: { adAccountId: "123456", accessToken: TOKEN },
    level: "account",
    window: "last_7d",
    fields: ["spend"],
  };
}

/** Stub de fetch que devolve `body` com status configurável e captura a chamada. */
function stubFetch(body: unknown, _ok = true, status = 200) {
  const spy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MetaGraphClient.buildUrl", () => {
  it("monta a URL versionada", () => {
    const client = new MetaGraphClient({ graphVersion: GRAPH_VERSION });
    expect(client.buildUrl("act_123/insights")).toBe(
      "https://graph.facebook.com/v26.0/act_123/insights",
    );
  });
});

describe("MetaInsightsService.getInsights (síncrono, Fatia 0)", () => {
  it("chama act_<id>/insights com fields=spend, date_preset=last_7d, level=account + Bearer + appsecret_proof", async () => {
    const spy = stubFetch({ data: [{ spend: "42.50" }] });
    const client = new MetaGraphClient({ graphVersion: GRAPH_VERSION, appSecret: APP_SECRET });
    const service = new MetaInsightsService(client);

    await service.getInsights(makeQuery());

    const [url, init] = spy.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe("/v26.0/act_123456/insights");
    expect(u.searchParams.get("fields")).toBe("spend");
    expect(u.searchParams.get("date_preset")).toBe("last_7d");
    expect(u.searchParams.get("level")).toBe("account");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    const expectedProof = createHmac("sha256", APP_SECRET).update(TOKEN).digest("hex");
    expect(u.searchParams.get("appsecret_proof")).toBe(expectedProof);
  });

  it("NÃO anexa appsecret_proof quando não há appSecret", async () => {
    const spy = stubFetch({ data: [{ spend: "1" }] });
    const service = new MetaInsightsService(new MetaGraphClient({ graphVersion: GRAPH_VERSION }));

    await service.getInsights(makeQuery());

    const u = new URL(String(spy.mock.calls[0]![0]));
    expect(u.searchParams.get("appsecret_proof")).toBeNull();
  });

  it("mapeia a linha p/ InsightRow (spend como número, nível account)", async () => {
    stubFetch({ data: [{ spend: "42.50" }] });
    const service = new MetaInsightsService(new MetaGraphClient({ graphVersion: GRAPH_VERSION }));

    const rows = await service.getInsights(makeQuery());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: "act_123456", level: "account" });
    expect(rows[0]!.metrics.spend).toBe(42.5);
  });

  it("conta sem gasto no período → data vazia → lista vazia", async () => {
    stubFetch({ data: [] });
    const service = new MetaInsightsService(new MetaGraphClient({ graphVersion: GRAPH_VERSION }));
    expect(await service.getInsights(makeQuery())).toEqual([]);
  });

  it("erro da Meta (token inválido, code 190) → lança MetaApiError com o code", async () => {
    stubFetch(
      { error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException" } },
      false,
      400,
    );
    const service = new MetaInsightsService(new MetaGraphClient({ graphVersion: GRAPH_VERSION }));

    await expect(service.getInsights(makeQuery())).rejects.toMatchObject({
      name: "MetaApiError",
      code: 190,
    });
    await expect(service.getInsights(makeQuery())).rejects.toBeInstanceOf(MetaApiError);
  });
});
