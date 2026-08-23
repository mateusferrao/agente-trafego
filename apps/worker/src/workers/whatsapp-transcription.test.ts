import { describe, expect, it, vi } from "vitest";
import { TranscriptionError } from "@trafego/shared/ports";
import type { TranscriptionResult } from "@trafego/shared/types";
import {
  makeTranscriptionProcessor,
  type TranscriptionJob,
  type TranscriptionProcessorDeps,
} from "./whatsapp-transcription.js";

const AUDIO_B64 = Buffer.from("nota de voz").toString("base64");

function fakeRedis(setResult: "OK" | null = "OK") {
  return {
    incr: vi.fn(async () => 1),
    decr: vi.fn(async () => 0),
    del: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    expire: vi.fn(async () => 1),
    rpush: vi.fn(async () => 1),
    set: vi.fn(async () => setResult),
  };
}

function makeDeps(overrides: Partial<TranscriptionProcessorDeps> = {}, setResult: "OK" | null = "OK") {
  const redis = fakeRedis(setResult);
  const flushQueue = { add: vi.fn(async () => ({})), remove: vi.fn(async () => 1) };
  const sendToContact = vi.fn(async () => true);
  const repo = {
    updateMessageContent: vi.fn(async () => {}),
    contextAdAccountId: vi.fn(async (): Promise<string | null> => null),
  };
  const metering = { record: vi.fn(async () => "evt-1"), updateCost: vi.fn(), summarize: vi.fn(), llmCostInPeriod: vi.fn() };
  const transcription = {
    transcribe: vi.fn(
      async (): Promise<TranscriptionResult> => ({ text: "olá pausa a campanha x", model: "whisper", costUsd: 0.0004, durationSec: 3.1, tokensUsed: 42 }),
    ),
  };
  const deps = {
    transcription,
    metering,
    redis,
    flushQueue,
    sendToContact,
    repo,
    logger: { warn: vi.fn() },
    debounceSeconds: 5,
    maxAudioMb: 16,
    language: "pt",
    provider: "openrouter",
    noticeThrottleSec: 60,
    transcribingTtlSec: 240,
    ...overrides,
  } as unknown as TranscriptionProcessorDeps;
  return { deps, redis, flushQueue, sendToContact, repo, metering, transcription };
}

function job(overrides: Partial<TranscriptionJob> = {}): TranscriptionJob {
  return {
    data: {
      orgId: "org-1",
      contactId: "c-1",
      conversationId: "conv-1",
      messageRowId: "msg-1",
      audio: { base64: AUDIO_B64, mimetype: "audio/ogg; codecs=opus" },
    },
    attemptsMade: 0,
    opts: { attempts: 2 },
    ...overrides,
  };
}

describe("makeTranscriptionProcessor", () => {
  it("sucesso com texto: grava transcript, mede custo, empurra no buffer, destrava flush", async () => {
    const t = makeDeps();
    await makeTranscriptionProcessor(t.deps)(job());

    expect(t.transcription.transcribe).toHaveBeenCalledWith({
      bytes: expect.any(Buffer),
      mimetype: "audio/ogg; codecs=opus",
      language: "pt",
    });
    expect(t.repo.updateMessageContent).toHaveBeenCalledWith("msg-1", "olá pausa a campanha x", { transcribing: false, durationSec: 3.1 });
    expect(t.metering.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "transcription", provider: "openrouter", model: "whisper", costUsd: 0.0004 }),
    );
    expect(t.redis.rpush).toHaveBeenCalledWith("wa:inbuf:conv-1", "olá pausa a campanha x");
    expect(t.sendToContact).not.toHaveBeenCalled();
    // settle: destrava a flag + re-agenda o flush
    expect(t.redis.decr).toHaveBeenCalledWith("wa:transcribing:conv-1");
    expect(t.flushQueue.add).toHaveBeenCalled();
  });

  it("atribui a conta em contexto (sole ou foco) ao metering", async () => {
    const t = makeDeps();
    t.repo.contextAdAccountId.mockResolvedValueOnce("acc-9");
    await makeTranscriptionProcessor(t.deps)(job());
    expect(t.metering.record).toHaveBeenCalledWith(expect.objectContaining({ adAccountId: "acc-9" }));
  });

  it("transcript vazio: mede custo, avisa amigável, NÃO empurra no buffer", async () => {
    const t = makeDeps();
    t.transcription.transcribe.mockResolvedValueOnce({ text: "   ", model: "whisper", costUsd: 0.0001, durationSec: 1 });
    await makeTranscriptionProcessor(t.deps)(job());

    expect(t.metering.record).toHaveBeenCalled(); // houve custo
    expect(t.repo.updateMessageContent).toHaveBeenCalledWith("msg-1", null, { transcribing: false, empty: true, durationSec: 1 });
    expect(t.sendToContact).toHaveBeenCalledWith("c-1", expect.stringContaining("não consegui ouvir nada"), { split: false });
    expect(t.redis.rpush).not.toHaveBeenCalled();
    expect(t.flushQueue.add).toHaveBeenCalled(); // settle mesmo assim
  });

  it("falha na última tentativa: avisa amigável + settle, sem push", async () => {
    const t = makeDeps();
    t.transcription.transcribe.mockRejectedValueOnce(new TranscriptionError("upstream", "502"));
    await makeTranscriptionProcessor(t.deps)(job({ attemptsMade: 1, opts: { attempts: 2 } }));

    expect(t.repo.updateMessageContent).toHaveBeenCalledWith("msg-1", null, { transcribing: false, error: "upstream" });
    expect(t.sendToContact).toHaveBeenCalledWith("c-1", expect.stringContaining("não consegui ouvir agora"), { split: false });
    expect(t.redis.rpush).not.toHaveBeenCalled();
    expect(t.redis.decr).toHaveBeenCalled();
  });

  it("falha transitória com tentativa sobrando: re-lança (BullMQ re-tenta), NÃO settle nem avisa", async () => {
    const t = makeDeps();
    t.transcription.transcribe.mockRejectedValueOnce(new TranscriptionError("timeout", "abortou"));
    await expect(makeTranscriptionProcessor(t.deps)(job({ attemptsMade: 0, opts: { attempts: 3 } }))).rejects.toMatchObject({ kind: "timeout" });
    expect(t.sendToContact).not.toHaveBeenCalled();
    expect(t.redis.decr).not.toHaveBeenCalled(); // flag segura o flush até a retentativa
    expect(t.flushQueue.add).not.toHaveBeenCalled();
  });

  it("erro permanente (áudio grande demais): falha na hora, sem chamar o provider nem re-tentar", async () => {
    const t = makeDeps({ maxAudioMb: 0.000001 }); // qualquer áudio estoura
    await makeTranscriptionProcessor(t.deps)(job({ attemptsMade: 0, opts: { attempts: 3 } }));
    expect(t.transcription.transcribe).not.toHaveBeenCalled();
    expect(t.sendToContact).toHaveBeenCalledWith("c-1", expect.stringContaining("não consegui ouvir agora"), { split: false });
    expect(t.repo.updateMessageContent).toHaveBeenCalledWith("msg-1", null, { transcribing: false, error: "too_large" });
    expect(t.redis.decr).toHaveBeenCalled(); // settle (permanente = terminal)
  });

  it("aviso throttled: se a janela já avisou (SET NX falhou), não reenvia", async () => {
    const t = makeDeps({}, null); // redis.set → null (janela já usada)
    t.transcription.transcribe.mockRejectedValueOnce(new TranscriptionError("upstream", "x"));
    await makeTranscriptionProcessor(t.deps)(job({ attemptsMade: 1, opts: { attempts: 2 } }));
    expect(t.sendToContact).not.toHaveBeenCalled(); // throttle barrou
  });
});
