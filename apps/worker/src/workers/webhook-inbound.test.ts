import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "@trafego/shared/ports";
import { makeInboundRouter, type InboundRouterDeps } from "./webhook-inbound.js";

const BASE = { instanceId: "inst-1", from: "+5511999999999", messageId: "MID-1", raw: {} } as const;
const TEXT: InboundMessage = { ...BASE, kind: "text", text: "oi" };
const AUDIO_KEY = { id: "MID-1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false };
const AUDIO: InboundMessage = {
  ...BASE,
  kind: "audio",
  audio: { base64: "AAAA", mimetype: "audio/ogg" },
  messageKey: AUDIO_KEY,
};
const UNSUPPORTED: InboundMessage = { ...BASE, kind: "unsupported", mediaType: "image" };

const BOT_PHONE = "+5511900000000";
const GROUP_JID = "120363000000000000@g.us";
const GROUP_BASE = { instanceId: "inst-1", from: "+5511999999999", messageId: "GMSG-1", raw: {} } as const;

function groupText(
  overrides: {
    senderPhone?: string;
    senderName?: string | null;
    mentionedPhones?: string[];
    quotedAuthorPhone?: string | null;
    mentionedLids?: string[];
    quotedAuthorLid?: string | null;
    quotedStanzaId?: string | null;
    quotedKind?: "text" | "audio" | "image" | "media" | null;
    quotedSnippet?: string | null;
  } = {},
): InboundMessage {
  return {
    ...GROUP_BASE,
    kind: "text",
    text: "@bot analisa",
    group: {
      groupJid: GROUP_JID,
      senderPhone: overrides.senderPhone ?? "+5511999999999",
      senderName: overrides.senderName === undefined ? "João" : overrides.senderName,
      mentionedPhones: overrides.mentionedPhones ?? [BOT_PHONE],
      quotedAuthorPhone: overrides.quotedAuthorPhone ?? null,
      mentionedLids: overrides.mentionedLids ?? [],
      quotedAuthorLid: overrides.quotedAuthorLid ?? null,
      quotedStanzaId: overrides.quotedStanzaId ?? null,
      quotedKind: overrides.quotedKind ?? null,
      quotedSnippet: overrides.quotedSnippet ?? null,
    },
  };
}

/** Variante de mídia não-dirigida em grupo (áudio/imagem) p/ o placeholder de contexto. */
function groupMedia(kind: "audio" | "unsupported", mediaType = "image"): InboundMessage {
  const group = {
    groupJid: GROUP_JID,
    senderPhone: "+5511999999999",
    senderName: "João" as string | null,
    mentionedPhones: [] as string[],
    quotedAuthorPhone: null,
    mentionedLids: [] as string[],
    quotedAuthorLid: null,
    quotedStanzaId: null,
    quotedKind: null,
    quotedSnippet: null,
  };
  if (kind === "audio") {
    return { ...GROUP_BASE, kind: "audio", audio: { base64: "AAAA", mimetype: "audio/ogg" }, messageKey: { id: "GMSG-1", remoteJid: GROUP_JID, fromMe: false }, group };
  }
  return { ...GROUP_BASE, kind: "unsupported", mediaType, group };
}

function makeDeps(overrides: Partial<InboundRouterDeps> = {}) {
  const repo = {
    resolveInboundContact: vi.fn(async (): Promise<{ orgId: string; contactId: string } | null> => ({ orgId: "org-1", contactId: "c-1" })),
    alreadyProcessed: vi.fn(async () => false),
    ensureConversation: vi.fn(async () => "conv-1"),
    recordMessage: vi.fn(async () => "msg-1"),
    instancePhone: vi.fn(async (): Promise<string | null> => BOT_PHONE),
    resolveInboundGroup: vi.fn(async (): Promise<{ orgId: string; groupId: string } | null> => ({ orgId: "org-1", groupId: "grp-1" })),
    ensureGroupConversation: vi.fn(async () => "conv-grp-1"),
    recordGroupMessage: vi.fn(async () => undefined),
  };
  const messaging = { resolveGroupParticipants: vi.fn(async (): Promise<Record<string, string>> => ({})) };
  // markTranscribing usa MULTI (incr+expire atômico) — chain espionável.
  const multiChain = { incr: vi.fn(() => multiChain), expire: vi.fn(() => multiChain), exec: vi.fn(async () => []) };
  const redis = {
    rpush: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    get: vi.fn(async (): Promise<string | null> => null),
    set: vi.fn(async (): Promise<"OK" | null> => "OK"),
    multi: vi.fn(() => multiChain),
  };
  const flushQueue = { add: vi.fn(async () => ({})), remove: vi.fn(async () => 1) };
  const transcriptionQueue = { add: vi.fn(async () => ({})) };
  const mediaIntakeQueue = { add: vi.fn(async () => ({})) };
  const creativeVideoAnalyzeQueue = { add: vi.fn(async () => ({})) };
  const sendToConversation = vi.fn(async () => true);
  const deps = {
    repo,
    messaging,
    redis,
    flushQueue,
    transcriptionQueue,
    mediaIntakeQueue,
    creativeVideoAnalyzeQueue,
    sendToConversation,
    logger: { debug: vi.fn() },
    debounceMs: 5000,
    bufferTtlSec: 65,
    transcribingTtlSec: 240,
    throttleSec: 5,
    groupIngestContext: true,
    groupParticipantsCacheTtlSec: 3600,
    ...overrides,
  } as unknown as InboundRouterDeps;
  return { deps, repo, messaging, redis, multiChain, flushQueue, transcriptionQueue, mediaIntakeQueue, creativeVideoAnalyzeQueue, sendToConversation };
}

const VIDEO_KEY = { id: "MID-1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false };
const VIDEO_WITH_CAPTION: InboundMessage = {
  ...BASE,
  kind: "video",
  video: { mimetype: "video/mp4" },
  caption: "coloque este vídeo na campanha D.A leads",
  messageKey: VIDEO_KEY,
};

describe("makeInboundRouter — DM", () => {
  it("texto: grava, bufferiza e agenda o flush (sem transcrição/aviso)", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", TEXT);
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-1", "inbound", "oi", { messageId: "MID-1" });
    expect(t.redis.rpush).toHaveBeenCalledWith("wa:inbuf:conv-1", "oi");
    expect(t.flushQueue.add).toHaveBeenCalled();
    expect(t.transcriptionQueue.add).not.toHaveBeenCalled();
    expect(t.sendToConversation).not.toHaveBeenCalled();
  });

  it("áudio: grava vazio (transcribing), marca a flag, enfileira transcrição e agenda o flush", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", AUDIO);
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-1", "inbound", null, {
      messageId: "MID-1",
      kind: "audio",
      transcribing: true,
    });
    expect(t.multiChain.incr).toHaveBeenCalledWith("wa:transcribing:conv-1");
    expect(t.transcriptionQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        conversationId: "conv-1",
        ref: { kind: "contact", contactId: "c-1" },
        messageRowId: "msg-1",
        instanceId: "inst-1",
        audio: { base64: "AAAA", mimetype: "audio/ogg", messageKey: AUDIO_KEY },
      }),
      expect.objectContaining({ attempts: 3 }),
    );
    expect(t.flushQueue.add).toHaveBeenCalled();
    expect(t.redis.rpush).not.toHaveBeenCalled(); // nada no buffer ainda (só após transcrever)
  });

  it("vídeo com legenda (instrução): SEGURA o flush, salva em silêncio, enfileira a análise e dá o ack — a legenda NÃO vai pro buffer aqui (o worker encaminha depois)", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", VIDEO_WITH_CAPTION);
    // hold: marca transcribing (segura o flush até a análise rodar)
    expect(t.multiChain.incr).toHaveBeenCalledWith("wa:transcribing:conv-1");
    // intake salva em SILÊNCIO (o turno/análise é a voz)
    expect(t.mediaIntakeQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ conversationId: "conv-1", suppressNotice: true }),
      expect.anything(),
    );
    // análise (worker próprio) enfileirada com a legenda
    expect(t.creativeVideoAnalyzeQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ conversationId: "conv-1", caption: "coloque este vídeo na campanha D.A leads" }),
      expect.anything(),
    );
    expect(t.sendToConversation).toHaveBeenCalledOnce(); // ack imediato
    expect(t.redis.rpush).not.toHaveBeenCalled(); // a legenda NÃO entra no buffer aqui (o worker empurra após a visão)
  });

  it("mídia não-suportada: grava + aviso throttled, sem buffer/flush/transcrição", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", UNSUPPORTED);
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-1", "inbound", null, {
      messageId: "MID-1",
      kind: "unsupported",
      mediaType: "image",
    });
    expect(t.sendToConversation).toHaveBeenCalledWith(
      { kind: "contact", contactId: "c-1" },
      expect.stringContaining("só entendo texto e áudio"),
      { split: false },
    );
    expect(t.redis.rpush).not.toHaveBeenCalled();
    expect(t.flushQueue.add).not.toHaveBeenCalled();
    expect(t.transcriptionQueue.add).not.toHaveBeenCalled();
  });

  it("remetente desconhecido → silêncio (nada gravado)", async () => {
    const t = makeDeps();
    t.repo.resolveInboundContact.mockResolvedValueOnce(null);
    await makeInboundRouter(t.deps)("inst-1", AUDIO);
    expect(t.repo.recordMessage).not.toHaveBeenCalled();
    expect(t.transcriptionQueue.add).not.toHaveBeenCalled();
  });

  it("mensagem duplicada → ignora (dedupe atômico via SET NX: null = já reivindicado)", async () => {
    const t = makeDeps();
    t.redis.set.mockResolvedValueOnce(null); // SET NX devolve null quando a chave já existe (duplicata)
    await makeInboundRouter(t.deps)("inst-1", AUDIO);
    expect(t.repo.recordMessage).not.toHaveBeenCalled();
    expect(t.transcriptionQueue.add).not.toHaveBeenCalled();
  });
});

describe("makeInboundRouter — grupo", () => {
  it("dirigido (@menção ao bot): grava, bufferiza e agenda o flush no thread do grupo/participante", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText());
    expect(t.repo.resolveInboundGroup).toHaveBeenCalledWith("inst-1", GROUP_JID);
    expect(t.repo.ensureGroupConversation).toHaveBeenCalledWith("org-1", "grp-1", "+5511999999999");
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", "@bot analisa", { messageId: "GMSG-1", authorName: "João" });
    expect(t.flushQueue.add).toHaveBeenCalled();
  });

  it("dirigido por REPLY à msg do bot (sem menção): processa + marca quotedFromBot", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: [], quotedAuthorPhone: BOT_PHONE, quotedKind: "text", quotedSnippet: "pausei a X" }));
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", "@bot analisa", {
      messageId: "GMSG-1",
      authorName: "João",
      quotedAuthorPhone: BOT_PHONE,
      quotedSnippet: "pausei a X",
      quotedFromBot: true,
    });
  });

  it("grupo NÃO registrado → silêncio (nada gravado)", async () => {
    const t = makeDeps();
    t.repo.resolveInboundGroup.mockResolvedValueOnce(null);
    await makeInboundRouter(t.deps)("inst-1", groupText());
    expect(t.repo.recordMessage).not.toHaveBeenCalled();
    expect(t.flushQueue.add).not.toHaveBeenCalled();
  });

  it("NÃO dirigido (sem menção/reply ao bot) → não fabrica thread nem dispara turno", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: ["+5511888888888"] }));
    expect(t.repo.recordMessage).not.toHaveBeenCalled();
    expect(t.repo.ensureGroupConversation).not.toHaveBeenCalled();
    expect(t.flushQueue.add).not.toHaveBeenCalled();
  });

  it("NÃO dirigido + ingest ON (default) → grava em group_messages (contexto ambiente), sem thread/turno", async () => {
    const t = makeDeps({ groupIngestContext: true });
    await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: ["+5511888888888"] }));
    expect(t.repo.recordGroupMessage).toHaveBeenCalledWith({
      orgId: "org-1",
      groupId: "grp-1",
      authorPhone: "+5511999999999",
      authorName: "João",
      body: "@bot analisa",
      messageId: "GMSG-1",
      quotedAuthorPhone: null,
      quotedSnippet: null,
    });
    // não fabrica conversa, não grava em messages, não dispara turno.
    expect(t.repo.ensureGroupConversation).not.toHaveBeenCalled();
    expect(t.repo.recordMessage).not.toHaveBeenCalled();
    expect(t.flushQueue.add).not.toHaveBeenCalled();
  });

  it("NÃO dirigido + ingest ON: áudio vira placeholder [áudio] (sem transcrever)", async () => {
    const t = makeDeps({ groupIngestContext: true });
    await makeInboundRouter(t.deps)("inst-1", groupMedia("audio"));
    expect(t.repo.recordGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ body: "[áudio]" }));
    expect(t.transcriptionQueue.add).not.toHaveBeenCalled();
  });

  it("NÃO dirigido + ingest ON: imagem vira [imagem], mídia sem placeholder vira [mídia]", async () => {
    const t = makeDeps({ groupIngestContext: true });
    await makeInboundRouter(t.deps)("inst-1", groupMedia("unsupported", "image"));
    expect(t.repo.recordGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ body: "[imagem]" }));
    // document não tem placeholder próprio → cai no default "[mídia]".
    await makeInboundRouter(t.deps)("inst-1", groupMedia("unsupported", "document"));
    expect(t.repo.recordGroupMessage).toHaveBeenLastCalledWith(expect.objectContaining({ body: "[mídia]" }));
  });

  it("NÃO dirigido + ingest OFF (kill-switch) → nem group_messages", async () => {
    const t = makeDeps({ groupIngestContext: false });
    await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: ["+5511888888888"] }));
    expect(t.repo.recordGroupMessage).not.toHaveBeenCalled();
  });

  it("dirigido em REPLY → grava quotedAuthorPhone + quotedSnippet no meta (contexto de reply)", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText({ quotedAuthorPhone: "+5511777777777", quotedKind: "text", quotedSnippet: "Oi" }));
    expect(t.repo.recordMessage).toHaveBeenCalledWith(
      "conv-grp-1",
      "inbound",
      "@bot analisa",
      expect.objectContaining({ quotedAuthorPhone: "+5511777777777", quotedSnippet: "Oi" }),
    );
  });

  it("S7 — dirigido em REPLY de texto injeta a mensagem CITADA na intenção do turno", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)(
      "inst-1",
      groupText({ quotedAuthorPhone: "+5511777777777", quotedKind: "text", quotedSnippet: "quantos leads até 12h?" }),
    );
    // a msg PERSISTIDA segue a original; o BUFFER (turno) leva a citação injetada.
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", "@bot analisa", expect.anything());
    const buffered = t.redis.rpush.mock.calls.flat().join(" ");
    expect(buffered).toContain("quantos leads até 12h?");
    expect(buffered).toContain("@bot analisa");
  });

  it("S7 — dirigido SEM citação não injeta prefixo (buffer = texto original)", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText({ quotedSnippet: null, quotedKind: null }));
    const buffered = t.redis.rpush.mock.calls.flat().join(" ");
    expect(buffered).toContain("@bot analisa");
    expect(buffered).not.toContain("Em resposta");
  });

  it("(b) dirigido respondendo um ÁUDIO → enfileira transcrição do citado com o texto do turno", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)(
      "inst-1",
      groupText({ quotedAuthorPhone: "+5511777777777", quotedKind: "audio", quotedStanzaId: "AUD-1" }),
    );
    // grava a dirigida com citação [áudio]; NÃO bufferiza o texto direto (espera a transcrição).
    expect(t.repo.recordMessage).toHaveBeenCalledWith(
      "conv-grp-1",
      "inbound",
      "@bot analisa",
      expect.objectContaining({ quotedAuthorPhone: "+5511777777777", quotedSnippet: "[áudio]" }),
    );
    expect(t.redis.rpush).not.toHaveBeenCalled(); // o texto entra combinado após transcrever
    expect(t.transcriptionQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        quotedAudioContext: { userText: "@bot analisa", authorLabel: "Participante-7777" },
        audio: expect.objectContaining({ messageKey: expect.objectContaining({ id: "AUD-1", remoteJid: GROUP_JID }) }),
      }),
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it("ambiente em REPLY a áudio → group_messages com quotedSnippet [áudio]", async () => {
    const t = makeDeps({ groupIngestContext: true });
    await makeInboundRouter(t.deps)(
      "inst-1",
      groupText({ mentionedPhones: ["+5511888888888"], quotedAuthorPhone: "+5511777777777", quotedKind: "audio", quotedSnippet: null }),
    );
    expect(t.repo.recordGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ quotedAuthorPhone: "+5511777777777", quotedSnippet: "[áudio]" }),
    );
  });

  it("(a) nota de voz DIRIGIDA (reply ao bot) → transcreve com atribuição do autor", async () => {
    const t = makeDeps();
    const base = groupMedia("audio");
    const inbound = { ...base, group: { ...base.group, mentionedPhones: [BOT_PHONE] } } as InboundMessage;
    await makeInboundRouter(t.deps)("inst-1", inbound);
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", null, {
      messageId: "GMSG-1",
      kind: "audio",
      transcribing: true,
      authorName: "João",
    });
    expect(t.transcriptionQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        conversationId: "conv-grp-1",
        ref: { kind: "group", groupId: "grp-1", participantPhone: "+5511999999999" },
        messageRowId: "msg-1",
        audio: expect.objectContaining({ messageKey: { id: "GMSG-1", remoteJid: GROUP_JID, fromMe: false } }),
      }),
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it("sem verificação de membro: mensagem de grupo NÃO passa por resolveInboundContact", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText());
    expect(t.repo.resolveInboundContact).not.toHaveBeenCalled();
  });

  it("G3 — participantes DIFERENTES do mesmo grupo caem em threads DIFERENTES (isolamento: 'só o iniciador confirma')", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText());
    await makeInboundRouter(t.deps)("inst-1", groupText({ senderPhone: "+5511777777777" }));

    expect(t.repo.ensureGroupConversation).toHaveBeenNthCalledWith(1, "org-1", "grp-1", "+5511999999999");
    expect(t.repo.ensureGroupConversation).toHaveBeenNthCalledWith(2, "org-1", "grp-1", "+5511777777777");
  });

  describe("endereçamento por LID (grupo migrado, addressingMode lid)", () => {
    const BOT_LID = "95529518235847@lid";

    it("@menção só por LID: resolve via mapa de participantes (cache-first) e processa como dirigido", async () => {
      const t = makeDeps();
      t.messaging.resolveGroupParticipants.mockResolvedValueOnce({ [BOT_LID]: BOT_PHONE });

      await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: [], mentionedLids: [BOT_LID] }));

      expect(t.messaging.resolveGroupParticipants).toHaveBeenCalledWith({ instanceId: "inst-1" }, GROUP_JID);
      expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", "@bot analisa", { messageId: "GMSG-1", authorName: "João" });
    });

    it("reply só por LID (quotedAuthorLid) ao BOT: resolve o telefone e rotula como assistente", async () => {
      const t = makeDeps();
      t.messaging.resolveGroupParticipants.mockResolvedValueOnce({ [BOT_LID]: BOT_PHONE });

      await makeInboundRouter(
        t.deps,
      )("inst-1", groupText({ mentionedPhones: [], quotedAuthorPhone: null, quotedAuthorLid: BOT_LID }));

      // o telefone resolvido via LID propaga downstream → quotedFromBot (S2 vale em grupo migrado).
      expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", "@bot analisa", {
        messageId: "GMSG-1",
        authorName: "João",
        quotedAuthorPhone: BOT_PHONE,
        quotedFromBot: true,
      });
    });

    it("LID mencionado NÃO é o do bot (mapa resolve pra outro telefone) → continua não-dirigido", async () => {
      const t = makeDeps();
      t.messaging.resolveGroupParticipants.mockResolvedValueOnce({ [BOT_LID]: "+5511222222222" });

      await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: [], mentionedLids: [BOT_LID] }));

      expect(t.repo.recordMessage).not.toHaveBeenCalled();
    });

    it("já dirigido por telefone direto → NÃO chama resolveGroupParticipants (evita bater na Evolution à toa)", async () => {
      const t = makeDeps();
      await makeInboundRouter(t.deps)("inst-1", groupText()); // mentionedPhones = [BOT_PHONE], sem LID
      expect(t.messaging.resolveGroupParticipants).not.toHaveBeenCalled();
    });

    it("sem menção/reply nenhuma → NÃO chama resolveGroupParticipants (maioria das mensagens de grupo)", async () => {
      const t = makeDeps();
      await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: [] }));
      expect(t.messaging.resolveGroupParticipants).not.toHaveBeenCalled();
    });
  });
});
