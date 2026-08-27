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

  it("LID (@lid, id opaco de grupo migrado) → null (não é telefone, não é reversível)", () => {
    expect(jidToE164("95529518235847@lid")).toBeNull();
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

  // ─── Imagem → kind:"image" (F7 intake: vira asset de criativo, não aviso) ───
  it("imageMessage (base64 inline) → kind image com bytes + caption", () => {
    const msg = parseInbound(
      upsert({ message: { imageMessage: { mimetype: "image/png", caption: "  logo nova  " }, base64: "IMG64" } }),
    );
    expect(msg).toMatchObject({
      kind: "image",
      image: { base64: "IMG64", mimetype: "image/png" },
      caption: "logo nova",
    });
  });

  it("imageMessage sem mimetype/caption → default image/jpeg + caption null", () => {
    const msg = parseInbound(upsert({ message: { imageMessage: { url: "x" }, base64: "Z" } }));
    expect(msg).toMatchObject({ kind: "image", image: { base64: "Z", mimetype: "image/jpeg" }, caption: null });
  });

  it("imagem carrega messageKey p/ o fallback fetchMediaBase64 (sem base64 inline)", () => {
    const msg = parseInbound(
      upsert({ remoteJid: "5531988887777@s.whatsapp.net", id: "IMG-KEY", message: { imageMessage: { url: "x" } } }),
    );
    expect(msg).toMatchObject({
      kind: "image",
      image: { base64: "" },
      messageKey: { id: "IMG-KEY", remoteJid: "5531988887777@s.whatsapp.net", fromMe: false },
    });
  });

  // ─── Vídeo → kind:"video" (F7 intake; sem base64 inline — busca por messageKey) ───
  it("videoMessage → kind video (mimetype + caption + messageKey; sem base64)", () => {
    const msg = parseInbound(
      upsert({ message: { videoMessage: { url: "x", mimetype: "video/mp4", caption: "promo" } } }),
    );
    expect(msg).toMatchObject({ kind: "video", video: { mimetype: "video/mp4" }, caption: "promo" });
    expect(msg).toHaveProperty("messageKey");
    expect(msg).not.toHaveProperty("video.base64");
  });

  // ─── Mídia reconhecida não-suportada → kind:"unsupported" (vira aviso) ───
  it.each([
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
  ])("%s → kind unsupported (%s)", (node, mediaType) => {
    const msg = parseInbound(upsert({ message: { [node]: { url: "x" } } }));
    expect(msg).toMatchObject({ kind: "unsupported", mediaType });
  });
});

/** Payload de MESSAGES_UPSERT vindo de um GRUPO (remoteJid @g.us + participant). */
function groupUpsert(overrides: {
  groupJid?: string;
  participant?: string;
  participantAlt?: string;
  id?: string;
  message?: Record<string, unknown>;
  contextInfo?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    event: "MESSAGES_UPSERT",
    instance: "org-123",
    data: {
      key: {
        remoteJid: overrides.groupJid ?? "120363000000000000@g.us",
        participant: overrides.participant ?? "5511999999999@s.whatsapp.net",
        ...(overrides.participantAlt ? { participantAlt: overrides.participantAlt } : {}),
        fromMe: false,
        id: overrides.id ?? "GROUPMSG1",
      },
      pushName: "Fulano",
      message: overrides.message ?? { conversation: "oi grupo" },
      ...(overrides.contextInfo ? { contextInfo: overrides.contextInfo } : {}),
      messageType: "conversation",
    },
  };
}

describe("parseInbound — grupo", () => {
  it("texto de grupo: from = telefone do participante + envelope group", () => {
    const msg = parseInbound(groupUpsert({}));
    expect(msg).toMatchObject({
      kind: "text",
      instanceId: "org-123",
      from: "+5511999999999",
      text: "oi grupo",
      group: {
        groupJid: "120363000000000000@g.us",
        senderPhone: "+5511999999999",
        senderName: "Fulano",
        mentionedPhones: [],
        quotedAuthorPhone: null,
      },
    });
  });

  it("sem pushName → senderName null (atribuição cai no fallback na casca)", () => {
    const payload = groupUpsert({});
    (payload.data as Record<string, unknown>).pushName = undefined;
    expect(parseInbound(payload)).toMatchObject({ group: { senderName: null } });
  });

  describe("mensagem citada (reply)", () => {
    it("reply a TEXTO → quotedKind text + snippet + stanzaId", () => {
      const msg = parseInbound(
        groupUpsert({ contextInfo: { participant: "5511777777777@s.whatsapp.net", stanzaId: "Q1", quotedMessage: { conversation: "Oi pessoal" } } }),
      );
      expect(msg).toMatchObject({
        group: { quotedAuthorPhone: "+5511777777777", quotedStanzaId: "Q1", quotedKind: "text", quotedSnippet: "Oi pessoal" },
      });
    });

    it("reply a ÁUDIO → quotedKind audio + snippet null (a casca transcreve pelo stanzaId)", () => {
      const msg = parseInbound(
        groupUpsert({ contextInfo: { participant: "5511777777777@s.whatsapp.net", stanzaId: "Q2", quotedMessage: { audioMessage: { mimetype: "audio/ogg" } } } }),
      );
      expect(msg).toMatchObject({ group: { quotedStanzaId: "Q2", quotedKind: "audio", quotedSnippet: null } });
    });

    it("reply a IMAGEM → quotedKind image", () => {
      const msg = parseInbound(groupUpsert({ contextInfo: { stanzaId: "Q3", quotedMessage: { imageMessage: {} } } }));
      expect(msg).toMatchObject({ group: { quotedKind: "image", quotedSnippet: null } });
    });

    it("sem citação → quoted* null", () => {
      expect(parseInbound(groupUpsert({}))).toMatchObject({ group: { quotedStanzaId: null, quotedKind: null, quotedSnippet: null } });
    });

    it("texto citado longo → trunca com reticências", () => {
      const long = "a".repeat(250);
      const msg = parseInbound(groupUpsert({ contextInfo: { stanzaId: "Q4", quotedMessage: { conversation: long } } })) as { group: { quotedSnippet: string } };
      expect(msg.group.quotedSnippet.length).toBeLessThan(long.length);
      expect(msg.group.quotedSnippet.endsWith("…")).toBe(true);
    });
  });

  it("grupo sem participant identificável → null (não dá pra rotear)", () => {
    const payload = groupUpsert({ participant: "" });
    // remove o participant do payload
    (((payload.data as Record<string, unknown>).key as Record<string, unknown>).participant as unknown) = undefined;
    expect(parseInbound(payload)).toBeNull();
  });

  it("extrai mentionedJid (marcações @) → mentionedPhones em E.164", () => {
    const msg = parseInbound(
      groupUpsert({
        message: {
          extendedTextMessage: {
            text: "@bot analisa",
            contextInfo: { mentionedJid: ["5511888888888@s.whatsapp.net", "120363@g.us"] },
          },
        },
      }),
    );
    // grupo mencionado (@g.us) é descartado; só telefones válidos entram
    expect(msg).toMatchObject({ kind: "text", group: { mentionedPhones: ["+5511888888888"] } });
  });

  it("extrai o autor da mensagem citada (reply) → quotedAuthorPhone", () => {
    const msg = parseInbound(
      groupUpsert({
        message: {
          extendedTextMessage: {
            text: "confirma",
            contextInfo: { participant: "5511777777777@s.whatsapp.net", stanzaId: "QUOTED1" },
          },
        },
      }),
    );
    expect(msg).toMatchObject({ kind: "text", group: { quotedAuthorPhone: "+5511777777777" } });
  });

  it("reply a mensagem do bot POR ÁUDIO (nota de voz): contextInfo mora em audioMessage, não extendedTextMessage — WhatsApp não permite @menção em áudio", () => {
    const msg = parseInbound(
      groupUpsert({
        message: {
          audioMessage: {
            ptt: true,
            contextInfo: { participant: "5511777777777@s.whatsapp.net", stanzaId: "QUOTED2" },
          },
          base64: "AAAA",
        },
      }),
    );
    expect(msg).toMatchObject({ kind: "audio", group: { quotedAuthorPhone: "+5511777777777" } });
  });

  it("áudio de grupo: envelope group + messageKey.remoteJid = JID do grupo", () => {
    const msg = parseInbound(groupUpsert({ message: { audioMessage: { ptt: true }, base64: "AAAA" } }));
    expect(msg).toMatchObject({
      kind: "audio",
      from: "+5511999999999",
      group: { groupJid: "120363000000000000@g.us", senderPhone: "+5511999999999" },
      messageKey: { remoteJid: "120363000000000000@g.us", fromMe: false },
    });
  });

  // ─── Regressão: contextInfo como IRMÃO de `message` em `data` (formato real da
  // Evolution — não aninhado em message.extendedTextMessage.contextInfo) + grupo
  // migrado pra LID (addressingMode "lid", participant vira id opaco). Reproduz
  // payload observado em produção. ───
  describe("formato real da Evolution (contextInfo em data, não aninhado)", () => {
    it("extrai mentionedJid de data.contextInfo (irmão de message, não dentro dele)", () => {
      const msg = parseInbound(
        groupUpsert({
          message: { conversation: "@bot analisa" },
          contextInfo: { mentionedJid: ["5511888888888@s.whatsapp.net"], groupMentions: [] },
        }),
      );
      expect(msg).toMatchObject({ kind: "text", group: { mentionedPhones: ["+5511888888888"] } });
    });

    it("extrai o autor citado (reply) de data.contextInfo.participant", () => {
      const msg = parseInbound(
        groupUpsert({
          message: { conversation: "confirma" },
          contextInfo: { mentionedJid: [], participant: "5511777777777@s.whatsapp.net", stanzaId: "QUOTED1" },
        }),
      );
      expect(msg).toMatchObject({ kind: "text", group: { quotedAuthorPhone: "+5511777777777" } });
    });

    it("grupo em addressingMode lid: participant é @lid, mas participantAlt tem o telefone real do remetente", () => {
      const msg = parseInbound(
        groupUpsert({
          participant: "251165459624058@lid",
          participantAlt: "5531999999999@s.whatsapp.net",
          message: { conversation: "oi" },
        }),
      );
      // senderPhone/from vêm do participantAlt (telefone real), não do LID do participant.
      expect(msg).toMatchObject({ from: "+5531999999999", group: { senderPhone: "+5531999999999" } });
    });

    it("menção/reply endereçando o bot por LID (sem alt disponível pra terceiros): não vira telefone, mas também não quebra — mentionedPhones/quotedAuthorPhone ficam vazios (LID não é reversível; endereçamento por LID é fast-follow)", () => {
      const msg = parseInbound(
        groupUpsert({
          participant: "251165459624058@lid",
          participantAlt: "5531999999999@s.whatsapp.net",
          message: { conversation: "@bot oi" },
          contextInfo: { mentionedJid: ["95529518235847@lid"], groupMentions: [] },
        }),
      );
      expect(msg).toMatchObject({ group: { mentionedPhones: [] } });
    });
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
