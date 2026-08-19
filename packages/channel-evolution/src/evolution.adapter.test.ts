import { afterEach, describe, expect, it, vi } from "vitest";
import { EvolutionClient } from "./client.js";
import { EvolutionAdapter } from "./evolution.adapter.js";

const BASE_URL = "https://evo.example.com";
const API_KEY = "evo-key-123";
const INSTANCE = { instanceId: "org-abc" };

/** fetch mock por rota: casa pelo sufixo do path → resposta {status, body}. */
function stubRoutes(routes: Record<string, { status: number; body: unknown }>) {
  const spy = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    const match = Object.keys(routes).find((suffix) => url.includes(suffix));
    const r = match ? routes[match]! : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

function makeAdapter(): EvolutionAdapter {
  return new EvolutionAdapter({ client: new EvolutionClient({ baseUrl: BASE_URL, apiKey: API_KEY }) });
}

describe("EvolutionAdapter.getState", () => {
  it("mapeia state 'open' → connected", async () => {
    stubRoutes({ "instance/connectionState/": { status: 200, body: { instance: { state: "open" } } } });
    expect(await makeAdapter().getState(INSTANCE)).toEqual({ status: "connected" });
  });

  it("mapeia state 'close' → disconnected", async () => {
    stubRoutes({ "instance/connectionState/": { status: 200, body: { instance: { state: "close" } } } });
    expect(await makeAdapter().getState(INSTANCE)).toEqual({ status: "disconnected" });
  });
});

describe("EvolutionAdapter.connect", () => {
  it("instância existente desconectada → retorna QR (connecting)", async () => {
    stubRoutes({
      "instance/connectionState/": { status: 200, body: { instance: { state: "close" } } },
      "instance/connect/": { status: 200, body: { base64: "data:image/png;base64,AAA" } },
    });
    expect(await makeAdapter().connect(INSTANCE)).toEqual({
      status: "connecting",
      qrCode: "data:image/png;base64,AAA",
    });
  });

  it("instância já pareada → connected (sem QR)", async () => {
    stubRoutes({
      "instance/connectionState/": { status: 200, body: { instance: { state: "open" } } },
      "instance/connect/": { status: 200, body: { instance: { state: "open" } } },
    });
    expect(await makeAdapter().connect(INSTANCE)).toEqual({ status: "connected" });
  });

  it("instância inexistente (404) → cria e depois retorna QR", async () => {
    const spy = stubRoutes({
      "instance/connectionState/": { status: 404, body: { error: "not found" } },
      "instance/create": { status: 201, body: { instance: { instanceName: INSTANCE.instanceId } } },
      "instance/connect/": { status: 200, body: { base64: "data:image/png;base64,BBB" } },
    });
    const state = await makeAdapter().connect(INSTANCE);
    expect(state).toEqual({ status: "connecting", qrCode: "data:image/png;base64,BBB" });
    // criou a instância antes de conectar
    const createdCall = spy.mock.calls.find(([url]) => String(url).includes("instance/create"));
    expect(createdCall).toBeDefined();
    expect(JSON.parse(String(createdCall![1]?.body))).toMatchObject({ instanceName: INSTANCE.instanceId });
  });
});
