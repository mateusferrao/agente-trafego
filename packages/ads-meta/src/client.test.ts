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
      act_1: { callCountPct: 10, totalCputimePct: 20, totalTimePct: 30, estimatedTimeToRegainAccessMin: 5 },
    });
  });
});

describe("MetaGraphClient — timeout", () => {
  it("request: passa signal com o timeout configurado (default 30s)", async () => {
    const spy = stubFetch("{}", true, 200);
    const c = new MetaGraphClient({ graphVersion: GRAPH_VERSION });
    await c.request({ method: "GET", path: "act_1/insights", accessToken: "t" });
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("request: usa o timeoutMs custom — fetch preso (nunca resolve) rejeita ao vencer o timeout", async () => {
    // AbortSignal.timeout é nativo (V8), não corre nos fake timers do vitest — usamos
    // um timeout REAL bem curto (5ms) pra provar o comportamento sem pesar a suíte.
    const spy = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", spy);
    const c = new MetaGraphClient({ graphVersion: GRAPH_VERSION, timeoutMs: 5 });

    await expect(c.request({ method: "GET", path: "act_1/insights", accessToken: "t" })).rejects.toThrow(/aborted/i);
  });

  it("batch: passa signal com o timeout configurado", async () => {
    const spy = stubFetch("[]", true, 200);
    const c = new MetaGraphClient({ graphVersion: GRAPH_VERSION });
    await c.batch("t", [{ method: "GET", relativeUrl: "act_1" }]);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
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
