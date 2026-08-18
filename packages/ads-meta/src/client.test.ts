import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaGraphClient, MetaApiError } from "./client.js";

const GRAPH_VERSION = "v26.0";

function stubFetch(body: string, ok: boolean, status: number, contentType = "application/json") {
  const spy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(body, { status, headers: { "content-type": contentType } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("MetaGraphClient.buildUrl", () => {
  it("versiona e remove barras à esquerda do path", () => {
    const c = new MetaGraphClient({ graphVersion: GRAPH_VERSION });
    expect(c.buildUrl("/act_1/insights")).toBe("https://graph.facebook.com/v26.0/act_1/insights");
  });
});

describe("MetaGraphClient.parseUsageHeader", () => {
  const c = new MetaGraphClient({ graphVersion: GRAPH_VERSION });

  it("header nulo → {}", () => {
    expect(c.parseUsageHeader(null)).toEqual({});
  });

  it("header malformado → {} (não derruba a request)", () => {
    expect(c.parseUsageHeader("isto não é json")).toEqual({});
  });

  it("mapeia call_count/total_cputime/total_time + regain", () => {
    const header = JSON.stringify({
      act_1: [{ call_count: 10, total_cputime: 20, total_time: 30, estimated_time_to_regain_access: 5 }],
    });
    expect(c.parseUsageHeader(header)).toEqual({
      act_1: { callCountPct: 10, totalCputimePct: 20, totalTimePct: 30, estimatedTimeToRegainAccessSec: 5 },
    });
  });
});

describe("MetaGraphClient.request — erro não-JSON", () => {
  it("502 com corpo HTML → MetaApiError com httpStatus (não SyntaxError)", async () => {
    stubFetch("<html>502 Bad Gateway</html>", false, 502, "text/html");
    const c = new MetaGraphClient({ graphVersion: GRAPH_VERSION });

    await expect(
      c.request({ method: "GET", path: "act_1/insights", accessToken: "t" }),
    ).rejects.toMatchObject({ name: "MetaApiError", httpStatus: 502 });
    await expect(
      c.request({ method: "GET", path: "act_1/insights", accessToken: "t" }),
    ).rejects.toBeInstanceOf(MetaApiError);
  });
});
