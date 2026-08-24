import { afterEach, describe, expect, it, vi } from "vitest";
import { EvolutionApiError, EvolutionClient } from "./client.js";

function stubFetch(body: string, ok: boolean, status: number) {
  const spy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(body, { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("EvolutionClient.request", () => {
  it("anexa header apikey + monta a URL sem barra dupla", async () => {
    const spy = stubFetch("{}", true, 200);
    const c = new EvolutionClient({ baseUrl: "https://evo.example.com", apiKey: "k" });
    await c.request({ method: "GET", path: "/instance/connectionState/x" });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://evo.example.com/instance/connectionState/x");
    expect((init as RequestInit).headers).toMatchObject({ apikey: "k" });
  });

  it("não-2xx → EvolutionApiError com httpStatus", async () => {
    stubFetch('{"message":"nope"}', false, 404);
    const c = new EvolutionClient({ baseUrl: "https://evo.example.com", apiKey: "k" });
    await expect(c.request({ method: "GET", path: "x" })).rejects.toThrow(EvolutionApiError);
  });
});

describe("EvolutionClient — timeout", () => {
  it("request: passa signal com o timeout configurado (default 30s)", async () => {
    const spy = stubFetch("{}", true, 200);
    const c = new EvolutionClient({ baseUrl: "https://evo.example.com", apiKey: "k" });
    await c.request({ method: "GET", path: "group/fetchAllGroups/x" });
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("usa o timeoutMs custom — fetch preso (nunca resolve) rejeita ao vencer o timeout em vez de ficar pendente pra sempre", async () => {
    // AbortSignal.timeout é nativo (V8), não corre nos fake timers do vitest — usamos
    // um timeout REAL bem curto (5ms) pra provar o comportamento sem pesar a suíte.
    const spy = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", spy);
    const c = new EvolutionClient({ baseUrl: "https://evo.example.com", apiKey: "k", timeoutMs: 5 });

    await expect(c.request({ method: "GET", path: "group/fetchAllGroups/x" })).rejects.toThrow(/aborted/i);
  });
});
