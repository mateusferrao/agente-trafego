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
  overrides: { senderPhone?: string; mentionedPhones?: string[]; quotedAuthorPhone?: string | null } = {},
): InboundMessage {
  return {
    ...GROUP_BASE,
    kind: "text",
    text: "@bot analisa",
    group: {
      groupJid: GROUP_JID,
      senderPhone: overrides.senderPhone ?? "+5511999999999",
      mentionedPhones: overrides.mentionedPhones ?? [BOT_PHONE],
      quotedAuthorPhone: overrides.quotedAuthorPhone ?? null,
    },
  };
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
  };
  // markTranscribing usa MULTI (incr+expire atômico) — chain espionável.
  const multiChain = { incr: vi.fn(() => multiChain), expire: vi.fn(() => multiChain), exec: vi.fn(async () => []) };
  const redis = {
    rpush: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    set: vi.fn(async () => "OK" as const),
    multi: vi.fn(() => multiChain),
  };
  const flushQueue = { add: vi.fn(async () => ({})), remove: vi.fn(async () => 1) };
  const transcriptionQueue = { add: vi.fn(async () => ({})) };
  const sendToConversation = vi.fn(async () => true);
  const deps = {
    repo,
    redis,
    flushQueue,
    transcriptionQueue,
    sendToConversation,
    logger: { debug: vi.fn() },
    debounceMs: 5000,
    bufferTtlSec: 65,
    transcribingTtlSec: 240,
    throttleSec: 5,
    groupIngestContext: false,
    ...overrides,
  } as unknown as InboundRouterDeps;
  return { deps, repo, redis, multiChain, flushQueue, transcriptionQueue, sendToConversation };
}

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

  it("mensagem duplicada → ignora (dedupe)", async () => {
    const t = makeDeps();
    t.repo.alreadyProcessed.mockResolvedValueOnce(true);
    await makeInboundRouter(t.deps)("inst-1", AUDIO);
    expect(t.repo.recordMessage).not.toHaveBeenCalled();
    expect(t.redis.multi).not.toHaveBeenCalled();
  });
});

describe("makeInboundRouter — grupo", () => {
  it("dirigido (@menção ao bot): grava, bufferiza e agenda o flush no thread do grupo/participante", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText());
    expect(t.repo.resolveInboundGroup).toHaveBeenCalledWith("inst-1", GROUP_JID);
    expect(t.repo.ensureGroupConversation).toHaveBeenCalledWith("org-1", "grp-1", "+5511999999999");
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", "@bot analisa", { messageId: "GMSG-1" });
    expect(t.flushQueue.add).toHaveBeenCalled();
  });

  it("dirigido por REPLY à msg do bot (sem menção): processa igual", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: [], quotedAuthorPhone: BOT_PHONE }));
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", "@bot analisa", { messageId: "GMSG-1" });
  });

  it("grupo NÃO registrado → silêncio (nada gravado)", async () => {
    const t = makeDeps();
    t.repo.resolveInboundGroup.mockResolvedValueOnce(null);
    await makeInboundRouter(t.deps)("inst-1", groupText());
    expect(t.repo.recordMessage).not.toHaveBeenCalled();
    expect(t.flushQueue.add).not.toHaveBeenCalled();
  });

  it("NÃO dirigido (sem menção/reply ao bot) + ingest OFF (default) → ignora, não persiste", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: ["+5511888888888"] }));
    expect(t.repo.recordMessage).not.toHaveBeenCalled();
    expect(t.flushQueue.add).not.toHaveBeenCalled();
  });

  it("NÃO dirigido + ingest ON (env) → persiste como contexto, sem turno (sem flush)", async () => {
    const t = makeDeps({ groupIngestContext: true });
    await makeInboundRouter(t.deps)("inst-1", groupText({ mentionedPhones: ["+5511888888888"] }));
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-grp-1", "inbound", "@bot analisa", {
      messageId: "GMSG-1",
      context: true,
    });
    expect(t.flushQueue.add).not.toHaveBeenCalled();
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
});
