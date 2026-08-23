import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "@trafego/shared/ports";
import { makeInboundRouter, type InboundRouterDeps } from "./webhook-inbound.js";

const BASE = { instanceId: "inst-1", from: "+5511999999999", messageId: "MID-1", raw: {} } as const;
const TEXT: InboundMessage = { ...BASE, kind: "text", text: "oi" };
const AUDIO: InboundMessage = { ...BASE, kind: "audio", audio: { base64: "AAAA", mimetype: "audio/ogg" } };
const UNSUPPORTED: InboundMessage = { ...BASE, kind: "unsupported", mediaType: "image" };

function makeDeps(overrides: Partial<InboundRouterDeps> = {}) {
  const repo = {
    resolveInboundContact: vi.fn(async (): Promise<{ orgId: string; contactId: string } | null> => ({ orgId: "org-1", contactId: "c-1" })),
    alreadyProcessed: vi.fn(async () => false),
    ensureConversation: vi.fn(async () => "conv-1"),
    recordMessage: vi.fn(async () => "msg-1"),
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
  const sendToContact = vi.fn(async () => true);
  const deps = {
    repo,
    redis,
    flushQueue,
    transcriptionQueue,
    sendToContact,
    logger: { debug: vi.fn() },
    debounceMs: 5000,
    bufferTtlSec: 65,
    transcribingTtlSec: 240,
    throttleSec: 5,
    ...overrides,
  } as unknown as InboundRouterDeps;
  return { deps, repo, redis, multiChain, flushQueue, transcriptionQueue, sendToContact };
}

describe("makeInboundRouter", () => {
  it("texto: grava, bufferiza e agenda o flush (sem transcrição/aviso)", async () => {
    const t = makeDeps();
    await makeInboundRouter(t.deps)("inst-1", TEXT);
    expect(t.repo.recordMessage).toHaveBeenCalledWith("conv-1", "inbound", "oi", { messageId: "MID-1" });
    expect(t.redis.rpush).toHaveBeenCalledWith("wa:inbuf:conv-1", "oi");
    expect(t.flushQueue.add).toHaveBeenCalled();
    expect(t.transcriptionQueue.add).not.toHaveBeenCalled();
    expect(t.sendToContact).not.toHaveBeenCalled();
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
      expect.objectContaining({ conversationId: "conv-1", messageRowId: "msg-1", audio: { base64: "AAAA", mimetype: "audio/ogg" } }),
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
    expect(t.sendToContact).toHaveBeenCalledWith("c-1", expect.stringContaining("só entendo texto e áudio"), { split: false });
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
