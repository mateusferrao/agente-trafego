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
      kind: "text",
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
    expect(msg).toMatchObject({ kind: "text", text: "mensagem longa aqui" });
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
    expect(parseInbound(upsert({ event: "messages.upsert" }))).toMatchObject({ kind: "text", text: "oi, tudo bem?" });
  });

  it("texto vazio/espaços → null", () => {
    expect(parseInbound(upsert({ message: { conversation: "   " } }))).toBeNull();
  });

  it("payload malformado (não-objeto) → null", () => {
    expect(parseInbound(null)).toBeNull();
    expect(parseInbound("x")).toBeNull();
    expect(parseInbound({})).toBeNull();
  });

  // ─── Áudio (nota de voz) → kind:"audio" com bytes inline (base64:true) ───
  it("áudio (audioMessage + base64 em data.message.base64) → kind audio", () => {
    const msg = parseInbound(
      upsert({ message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true }, base64: "AAAA" } }),
    );
    expect(msg).toMatchObject({ kind: "audio", audio: { base64: "AAAA", mimetype: "audio/ogg; codecs=opus" } });
  });

  it("áudio sem mimetype → default audio/ogg", () => {
    const msg = parseInbound(upsert({ message: { audioMessage: { ptt: true }, base64: "BBBB" } }));
    expect(msg).toMatchObject({ kind: "audio", audio: { base64: "BBBB", mimetype: "audio/ogg" } });
  });

  it("base64 defensivo: aceita data.base64 (fora de message)", () => {
    const payload = {
      event: "MESSAGES_UPSERT",
      instance: "org-1",
      data: {
        key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "MID1" },
        message: { audioMessage: { mimetype: "audio/ogg" } },
        base64: "CCCC",
      },
    };
    expect(parseInbound(payload)).toMatchObject({ kind: "audio", audio: { base64: "CCCC" } });
  });

  it("áudio sem base64 em nenhum candidato → kind audio com base64 vazio (worker trata como falha)", () => {
    const msg = parseInbound(upsert({ message: { audioMessage: { mimetype: "audio/ogg" } } }));
    expect(msg).toMatchObject({ kind: "audio", audio: { base64: "", mimetype: "audio/ogg" } });
  });

  it("áudio carrega messageKey (id/remoteJid/fromMe) p/ o fallback fetchMediaBase64", () => {
    const msg = parseInbound(
      upsert({ remoteJid: "5531999999999@s.whatsapp.net", id: "MSG-XYZ", message: { audioMessage: { ptt: true } } }),
    );
    expect(msg).toMatchObject({
      kind: "audio",
      messageKey: { id: "MSG-XYZ", remoteJid: "5531999999999@s.whatsapp.net", fromMe: false },
    });
  });

  // ─── Mídia reconhecida não-suportada → kind:"unsupported" (vira aviso) ───
  it.each([
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
  ])("%s → kind unsupported (%s)", (node, mediaType) => {
    const msg = parseInbound(upsert({ message: { [node]: { url: "x" } } }));
    expect(msg).toMatchObject({ kind: "unsupported", mediaType });
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
