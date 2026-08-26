import { afterEach, describe, expect, it, vi } from "vitest";
import { EvolutionClient } from "./client.js";
import { EvolutionSender } from "./send.js";

const BASE_URL = "https://evo.example.com";
const API_KEY = "evo-key-123";
const INSTANCE = { instanceId: "minha-instancia" };

function stubFetch(body: unknown, status = 201) {
  const spy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

function makeSender(): EvolutionSender {
  return new EvolutionSender(new EvolutionClient({ baseUrl: BASE_URL, apiKey: API_KEY }));
}

describe("EvolutionSender.sendText", () => {
  it("POST message/sendText/{instance} com header apikey e body { number, text }", async () => {
    const spy = stubFetch({ key: { id: "abc" }, status: "PENDING" });

    await makeSender().sendText(INSTANCE, { to: "5511999999999", text: "olá" });

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/message/sendText/${INSTANCE.instanceId}`);
    expect((init as RequestInit).method).toBe("POST");
    expect(init?.headers).toMatchObject({ apikey: API_KEY });
    expect(JSON.parse(String(init?.body))).toEqual({ number: "5511999999999", text: "olá" });
  });

  it("normaliza o telefone p/ só dígitos (sem +, espaços, JID)", async () => {
    const spy = stubFetch({ key: { id: "abc" } });

    await makeSender().sendText(INSTANCE, { to: "+55 (11) 99999-9999", text: "x" });

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body));
    expect(body.number).toBe("5511999999999");
  });

  it("traduz typingHintMs em delay + presence:composing ('digitando…')", async () => {
    const spy = stubFetch({ key: { id: "abc" } });

    await makeSender().sendText(INSTANCE, { to: "5511999999999", text: "oi", typingHintMs: 1500 });

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body));
    expect(body).toEqual({ number: "5511999999999", text: "oi", delay: 1500, presence: "composing" });
  });

  it("sem typingHintMs → body enxuto (sem delay/presence)", async () => {
    const spy = stubFetch({ key: { id: "abc" } });

    await makeSender().sendText(INSTANCE, { to: "5511999999999", text: "oi", typingHintMs: 0 });

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body));
    expect(body).toEqual({ number: "5511999999999", text: "oi" });
  });

  it("quoted → body inclui quoted { key:{id}, message:{conversation} }", async () => {
    const spy = stubFetch({ key: { id: "abc" } });

    await makeSender().sendText(INSTANCE, {
      to: "5511999999999",
      text: "resposta",
      quoted: { messageId: "WAMID-123", text: "pergunta original" },
    });

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body));
    expect(body.quoted).toEqual({ key: { id: "WAMID-123" }, message: { conversation: "pergunta original" } });
  });

  it("sem quoted → body sem o campo (contrato atual intacto)", async () => {
    const spy = stubFetch({ key: { id: "abc" } });

    await makeSender().sendText(INSTANCE, { to: "5511999999999", text: "oi" });

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body));
    expect(body.quoted).toBeUndefined();
  });

  it("toIsGroup: manda o JID do grupo intacto (sem normalizar)", async () => {
    const spy = stubFetch({ key: { id: "abc" } });

    await makeSender().sendText(INSTANCE, { to: "120363000000000000@g.us", text: "oi grupo", toIsGroup: true });

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body));
    expect(body.number).toBe("120363000000000000@g.us");
  });

  it("erro HTTP da Evolution → lança exceção na casca", async () => {
    stubFetch({ error: "bad request" }, 400);
    await expect(
      makeSender().sendText(INSTANCE, { to: "5511999999999", text: "x" }),
    ).rejects.toThrow();
  });
});
