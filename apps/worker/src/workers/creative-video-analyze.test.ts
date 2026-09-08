import { describe, expect, it, vi } from "vitest";
import type { CreativeVisionResult } from "@trafego/shared";
import type { CreativeVideoAnalyzePayload } from "@trafego/shared";
import { LLMProviderError } from "@trafego/shared/ports";
import { makeVideoAnalyze, type VideoAnalyzeDeps } from "./creative-video-analyze.js";

const VISION: CreativeVisionResult = {
  summary: "vídeo de depoimento",
  hook: "abre com resultado",
  angle: "prova social",
  format: "depoimento",
  body: "cliente conta a experiência",
  cta: "clique e compre",
  proofStrength: "strong",
  persuasionSignals: 3,
  strengths: ["gancho forte"],
  weaknesses: ["CTA tardio"],
  score: 8,
};

const payload = (over: Partial<CreativeVideoAnalyzePayload> = {}): CreativeVideoAnalyzePayload => ({
  orgId: "o1",
  ref: { kind: "contact", contactId: "c1" },
  conversationId: "conv1",
  instanceId: "inst1",
  messageKey: { id: "MSG1", remoteJid: "5511@s.whatsapp.net", fromMe: false },
  mimetype: "video/mp4",
  caption: "o que acha desse vídeo?",
  ...over,
});

function makeDeps(over: Partial<VideoAnalyzeDeps> = {}) {
  const send = vi.fn(async () => true);
  const resolve = vi.fn(async () => VISION as CreativeVisionResult | null);
  const complete = vi.fn(async () => ({ output: "Achei forte o gancho; só adiantaria o CTA.", usage: { inputTokens: 1, outputTokens: 1 } }));
  const fetchMediaBase64 = vi.fn(async () => Buffer.from("fakevideobytes").toString("base64") as string | null);
  const deps: VideoAnalyzeDeps = {
    vision: { resolve },
    llm: { complete } as unknown as VideoAnalyzeDeps["llm"],
    messaging: { fetchMediaBase64 },
    sendToConversation: send,
    messageModel: "m",
    videoModelMaxBytes: 20 * 1024 * 1024,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...over,
  };
  return { deps, send, resolve, complete, fetchMediaBase64 };
}

describe("makeVideoAnalyze (Slice 2 — análise de vídeo dos nossos bytes)", () => {
  it("dentro do teto → manda o vídeo (video_url) ao resolver + redige e empurra a resposta", async () => {
    const { deps, send, resolve, complete } = makeDeps();
    await makeVideoAnalyze(deps)(payload());
    // o resolver recebeu o vídeo COMPLETO como video_url (data-url), não frames.
    const arg = resolve.mock.calls[0]![0] as { videoUrl?: string; imageUrls: string[] };
    expect(arg.videoUrl).toMatch(/^data:video\/mp4;base64,/);
    expect(arg.imageUrls).toEqual([]);
    expect(complete).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ kind: "contact", contactId: "c1" }, "Achei forte o gancho; só adiantaria o CTA.", expect.objectContaining({ split: true }));
  });

  it("sem bytes → avisa honesto (não fica em silêncio), sem chamar visão", async () => {
    const { deps, send, resolve } = makeDeps({ messaging: { fetchMediaBase64: vi.fn(async () => null) } });
    await makeVideoAnalyze(deps)(payload());
    expect(resolve).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("vídeo acima do teto → degrada honesto (biblioteca analisa depois), sem chamar visão", async () => {
    const big = Buffer.alloc(30 * 1024 * 1024).toString("base64");
    const { deps, resolve, send } = makeDeps({ messaging: { fetchMediaBase64: vi.fn(async () => big) } });
    await makeVideoAnalyze(deps)(payload());
    expect(resolve).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("visão falha (null) → aviso honesto", async () => {
    const { deps, send, complete } = makeDeps({ vision: { resolve: vi.fn(async () => null) } });
    await makeVideoAnalyze(deps)(payload());
    expect(complete).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("erro do LLM na redação → aviso honesto (não quebra)", async () => {
    const complete = vi.fn(async () => {
      throw new LLMProviderError("timeout");
    });
    const { deps, send } = makeDeps({ llm: { complete } as unknown as VideoAnalyzeDeps["llm"] });
    await makeVideoAnalyze(deps)(payload());
    expect(send).toHaveBeenCalledOnce();
  });

  it("sem legenda → usa a pergunta padrão ('o que você acha')", async () => {
    const { deps, complete } = makeDeps();
    await makeVideoAnalyze(deps)(payload({ caption: null }));
    const messages = (complete.mock.calls[0]![0] as { messages: { content: string }[] }).messages;
    expect(messages[1]!.content).toContain("O que você acha");
  });
});
