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

const API_ORIGIN = "https://api.example.com";
function makeAdapterWithOrigin(): EvolutionAdapter {
  return new EvolutionAdapter({
    client: new EvolutionClient({ baseUrl: BASE_URL, apiKey: API_KEY }),
    apiOrigin: API_ORIGIN,
  });
}
function webhookSetCall(spy: ReturnType<typeof stubRoutes>) {
  return spy.mock.calls.find(([url]) => String(url).includes("webhook/set"));
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

describe("EvolutionAdapter.connect — ensureWebhook", () => {
  const ROUTES = {
    "instance/connectionState/": { status: 200, body: { instance: { state: "open" } } },
    "instance/connect/": { status: 200, body: { instance: { state: "open" } } },
    "webhook/set/": { status: 200, body: { webhook: { enabled: true } } },
  };

  it("registra o webhook (url + header do secret + eventos) quando há apiOrigin + secret", async () => {
    const spy = stubRoutes(ROUTES);
    await makeAdapterWithOrigin().connect({ instanceId: INSTANCE.instanceId, webhookSecret: "sec-123" });

    const call = webhookSetCall(spy);
    expect(call).toBeDefined();
    expect(String(call![0])).toBe(`${BASE_URL}/webhook/set/${INSTANCE.instanceId}`);
    const body = JSON.parse(String(call![1]?.body)).webhook;
    expect(body.url).toBe(`${API_ORIGIN}/webhooks/evolution/${INSTANCE.instanceId}`);
    expect(body.headers).toMatchObject({ "x-webhook-secret": "sec-123" });
    expect(body.events).toEqual(expect.arrayContaining(["MESSAGES_UPSERT", "CONNECTION_UPDATE"]));
  });

  it("sem apiOrigin → NÃO registra webhook", async () => {
    const spy = stubRoutes(ROUTES);
    await makeAdapter().connect({ instanceId: INSTANCE.instanceId, webhookSecret: "sec-123" });
    expect(webhookSetCall(spy)).toBeUndefined();
  });

  it("sem secret → NÃO registra webhook", async () => {
    const spy = stubRoutes(ROUTES);
    await makeAdapterWithOrigin().connect(INSTANCE);
    expect(webhookSetCall(spy)).toBeUndefined();
  });

  it("falha no webhook/set NÃO quebra o connect (best-effort)", async () => {
    stubRoutes({ ...ROUTES, "webhook/set/": { status: 500, body: { error: "boom" } } });
    const state = await makeAdapterWithOrigin().connect({
      instanceId: INSTANCE.instanceId,
      webhookSecret: "sec-123",
    });
    expect(state).toEqual({ status: "connected" });
  });
});

describe("EvolutionAdapter.syncWebhook", () => {
  const ROUTES = { "webhook/set/": { status: 200, body: { webhook: { enabled: true } } } };

  it("re-registra o webhook direto, sem passar por instance/connect (backfill one-time)", async () => {
    const spy = stubRoutes(ROUTES);
    await makeAdapterWithOrigin().syncWebhook({ instanceId: INSTANCE.instanceId, webhookSecret: "sec-123" });

    const call = webhookSetCall(spy);
    expect(call).toBeDefined();
    expect(String(call![0])).toBe(`${BASE_URL}/webhook/set/${INSTANCE.instanceId}`);
    const body = JSON.parse(String(call![1]?.body)).webhook;
    expect(body.base64).toBe(true);
  });

  it("sem apiOrigin ou secret → não registra e não lança", async () => {
    const spy = stubRoutes(ROUTES);
    await expect(makeAdapter().syncWebhook({ instanceId: INSTANCE.instanceId, webhookSecret: "sec-123" })).resolves.toBeUndefined();
    await expect(makeAdapterWithOrigin().syncWebhook(INSTANCE)).resolves.toBeUndefined();
    expect(webhookSetCall(spy)).toBeUndefined();
  });

  it("falha no webhook/set não lança (best-effort)", async () => {
    stubRoutes({ "webhook/set/": { status: 500, body: { error: "boom" } } });
    await expect(
      makeAdapterWithOrigin().syncWebhook({ instanceId: INSTANCE.instanceId, webhookSecret: "sec-123" }),
    ).resolves.toBeUndefined();
  });
});

describe("EvolutionAdapter.fetchMediaBase64", () => {
  const KEY = { id: "MSG-1", remoteJid: "5531999999999@s.whatsapp.net", fromMe: false };

  it("devolve o base64 quando a Evolution decripta a mídia", async () => {
    const spy = stubRoutes({
      "chat/getBase64FromMediaMessage/": { status: 200, body: { base64: "QUJD", mimetype: "audio/ogg" } },
    });
    const result = await makeAdapter().fetchMediaBase64(INSTANCE, KEY);

    expect(result).toBe("QUJD");
    const call = spy.mock.calls.find(([url]) => String(url).includes("chat/getBase64FromMediaMessage/"));
    expect(call).toBeDefined();
    expect(String(call![0])).toBe(`${BASE_URL}/chat/getBase64FromMediaMessage/${INSTANCE.instanceId}`);
    const body = JSON.parse(String(call![1]?.body));
    expect(body.message.key).toEqual(KEY);
  });

  it("mídia de GRUPO: repassa `participant` na key (Evolution exige p/ mídia de grupo)", async () => {
    const spy = stubRoutes({
      "chat/getBase64FromMediaMessage/": { status: 200, body: { base64: "QUJD" } },
    });
    const groupKey = { ...KEY, remoteJid: "120363000000000000@g.us", participant: "5511999999999@s.whatsapp.net" };

    await makeAdapter().fetchMediaBase64(INSTANCE, groupKey);

    const call = spy.mock.calls.find(([url]) => String(url).includes("chat/getBase64FromMediaMessage/"));
    const body = JSON.parse(String(call![1]?.body));
    expect(body.message.key).toEqual(groupKey);
  });

  it("resposta sem base64 → null", async () => {
    stubRoutes({ "chat/getBase64FromMediaMessage/": { status: 200, body: {} } });
    await expect(makeAdapter().fetchMediaBase64(INSTANCE, KEY)).resolves.toBeNull();
  });

  it("falha HTTP → null (best-effort, nunca lança)", async () => {
    stubRoutes({ "chat/getBase64FromMediaMessage/": { status: 500, body: { error: "boom" } } });
    await expect(makeAdapter().fetchMediaBase64(INSTANCE, KEY)).resolves.toBeNull();
  });
});

describe("EvolutionAdapter.listGroups", () => {
  it("mapeia id→jid, subject→name, size (getParticipants=false)", async () => {
    stubRoutes({
      "group/fetchAllGroups/": {
        status: 200,
        body: [
          { id: "120363000000000001@g.us", subject: "Sala de Guerra", size: 5 },
          { id: "120363000000000002@g.us", subject: "Outro grupo" },
        ],
      },
    });

    const result = await makeAdapter().listGroups(INSTANCE);

    expect(result).toEqual([
      { jid: "120363000000000001@g.us", name: "Sala de Guerra", size: 5 },
      { jid: "120363000000000002@g.us", name: "Outro grupo" },
    ]);
  });

  it("descarta linha sem id (defensivo)", async () => {
    stubRoutes({ "group/fetchAllGroups/": { status: 200, body: [{ subject: "sem id" }] } });
    await expect(makeAdapter().listGroups(INSTANCE)).resolves.toEqual([]);
  });

  it("resposta que não é array → []", async () => {
    stubRoutes({ "group/fetchAllGroups/": { status: 200, body: {} } });
    await expect(makeAdapter().listGroups(INSTANCE)).resolves.toEqual([]);
  });

  it("falha HTTP → lança erro neutro na casca", async () => {
    stubRoutes({ "group/fetchAllGroups/": { status: 500, body: { error: "boom" } } });
    await expect(makeAdapter().listGroups(INSTANCE)).rejects.toThrow();
  });
});
