import { describe, expect, it } from "vitest";
import { jidToE164, parseConnectionUpdate, parseInbound } from "./webhook.js";

/** Payload real (resumido) do evento MESSAGES_UPSERT da Evolution v2. */
function upsert(overrides: {
  event?: string;
  instance?: string;
  fromMe?: boolean;
  remoteJid?: string;
  id?: string;
  message?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    event: overrides.event ?? "MESSAGES_UPSERT",
    instance: overrides.instance ?? "org-123",
    data: {
      key: {
        remoteJid: overrides.remoteJid ?? "5511999999999@s.whatsapp.net",
        fromMe: overrides.fromMe ?? false,
        id: overrides.id ?? "3EB0C7B4E7A2B8E6D4F1",
      },
      pushName: "Fulano",
      message: overrides.message ?? { conversation: "oi, tudo bem?" },
      messageType: "conversation",
    },
  };
}

describe("jidToE164", () => {
  it("converte JID de usuário em E.164", () => {
    expect(jidToE164("5511999999999@s.whatsapp.net")).toBe("+5511999999999");
  });

  it("grupo (@g.us) → null", () => {
    expect(jidToE164("120363000000000000@g.us")).toBeNull();
  });

  it("JID com dígitos fora da faixa (DDI+telefone) → null", () => {
    expect(jidToE164("123@s.whatsapp.net")).toBeNull();
  });

  it("entrada não-string/vazia → null", () => {
    expect(jidToE164("")).toBeNull();
  });
});

describe("parseInbound", () => {
  it("normaliza mensagem de texto (conversation)", () => {
    const msg = parseInbound(upsert({}));
    expect(msg).toEqual({
      instanceId: "org-123",
      from: "+5511999999999",
      text: "oi, tudo bem?",
      messageId: "3EB0C7B4E7A2B8E6D4F1",
      raw: expect.any(Object),
    });
  });

  it("extrai texto de extendedTextMessage (mensagem longa)", () => {
    const msg = parseInbound(
      upsert({ message: { extendedTextMessage: { text: "mensagem longa aqui" } } }),
    );
    expect(msg?.text).toBe("mensagem longa aqui");
  });

  it("fromMe (nossa própria mensagem) → null", () => {
    expect(parseInbound(upsert({ fromMe: true }))).toBeNull();
  });

  it("mensagem de grupo (@g.us) → null", () => {
    expect(parseInbound(upsert({ remoteJid: "120363000000000000@g.us" }))).toBeNull();
  });

  it("evento não-mensagem (ex: CONNECTION_UPDATE) → null", () => {
    expect(parseInbound(upsert({ event: "CONNECTION_UPDATE" }))).toBeNull();
  });

  it("aceita o evento no formato pontilhado (messages.upsert)", () => {
    expect(parseInbound(upsert({ event: "messages.upsert" }))?.text).toBe("oi, tudo bem?");
  });

  it("mensagem não-texto (ex: imagem, sem conversation) → null", () => {
    expect(parseInbound(upsert({ message: { imageMessage: { url: "x" } } }))).toBeNull();
  });

  it("texto vazio/espaços → null", () => {
    expect(parseInbound(upsert({ message: { conversation: "   " } }))).toBeNull();
  });

  it("payload malformado (não-objeto) → null", () => {
    expect(parseInbound(null)).toBeNull();
    expect(parseInbound("x")).toBeNull();
    expect(parseInbound({})).toBeNull();
  });
});

describe("parseConnectionUpdate", () => {
  const conn = (state: unknown) => ({ event: "CONNECTION_UPDATE", instance: "org-1", data: { state } });

  it("open → connected", () => {
    expect(parseConnectionUpdate(conn("open"))).toBe("connected");
  });
  it("connecting → connecting", () => {
    expect(parseConnectionUpdate(conn("connecting"))).toBe("connecting");
  });
  it("close → disconnected", () => {
    expect(parseConnectionUpdate(conn("close"))).toBe("disconnected");
  });
  it("evento de mensagem → null (não é connection.update)", () => {
    expect(parseConnectionUpdate({ event: "MESSAGES_UPSERT", data: { state: "open" } })).toBeNull();
  });
  it("sem estado → null", () => {
    expect(parseConnectionUpdate(conn(undefined))).toBeNull();
  });
});
