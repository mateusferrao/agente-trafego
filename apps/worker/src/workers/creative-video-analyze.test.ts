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
  caption: "coloque este vídeo na campanha D.A leads", // legenda com INSTRUÇÃO → encaminha pro Grafo B
  ...over,
});

function makeDeps(over: Partial<VideoAnalyzeDeps> = {}) {
  const send = vi.fn(async (..._a: unknown[]) => true);
  const resolve = vi.fn(async (..._a: unknown[]) => VISION as CreativeVisionResult | null);
  const complete = vi.fn(async (..._a: unknown[]) => ({ output: "Achei forte o gancho; só adiantaria o CTA.", usage: { inputTokens: 1, outputTokens: 1 } }));
  const fetchMediaBase64 = vi.fn(async (..._a: unknown[]) => Buffer.from("fakevideobytes").toString("base64") as string | null);
  const handoffToConversation = vi.fn(async (..._a: unknown[]) => {});
  const releaseHold = vi.fn(async (..._a: unknown[]) => {});
  const deps: VideoAnalyzeDeps = {
    vision: { resolve },
    llm: { complete } as unknown as VideoAnalyzeDeps["llm"],
    messaging: { fetchMediaBase64 },
    sendToConversation: send,
    handoffToConversation,
    releaseHold,
    messageModel: "m",
    videoModelMaxBytes: 20 * 1024 * 1024,
    libraryMaxBytes: 50 * 1024 * 1024,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...over,
  };
  return { deps, send, resolve, complete, fetchMediaBase64, handoffToConversation, releaseHold };
}

describe("makeVideoAnalyze — B (unificar no Grafo B quando há legenda)", () => {
  it("COM legenda → produz a visão e ENCAMINHA pro Grafo B (não redige opinião solta)", async () => {
    const { deps, send, resolve, complete, handoffToConversation, releaseHold } = makeDeps();
    await makeVideoAnalyze(deps)(payload());
    // produz a visão (video_url completo → cacheada pro recall do Grafo B)
    const arg = resolve.mock.calls[0]![0] as { videoUrl?: string; imageUrls: string[] };
    expect(arg.videoUrl).toMatch(/^data:video\/mp4;base64,/);
    expect(resolve).toHaveBeenCalledOnce();
    // não fala pelo fast-path; o Grafo B é dono da resposta
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(handoffToConversation).toHaveBeenCalledOnce();
    // o próprio handoff libera o hold (na wiring real) → o worker NÃO chama releaseHold à parte
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("SEM legenda → redige a opinião do fast-path (como antes) e não encaminha; libera o hold", async () => {
    const { deps, send, resolve, complete, handoffToConversation, releaseHold } = makeDeps();
    await makeVideoAnalyze(deps)(payload({ caption: null }));
    const arg = resolve.mock.calls[0]![0] as { videoUrl?: string; imageUrls: string[] };
    expect(arg.videoUrl).toMatch(/^data:video\/mp4;base64,/);
    expect(arg.imageUrls).toEqual([]);
    expect(complete).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ kind: "contact", contactId: "c1" }, "Achei forte o gancho; só adiantaria o CTA.", expect.objectContaining({ split: true }));
    expect(handoffToConversation).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledOnce(); // libera pra msg concorrente flushar
  });

  it("visão FALHA (null) + legenda → ainda encaminha (a ação não depende da visão), sem aviso solto", async () => {
    const { deps, send, complete, handoffToConversation } = makeDeps({ vision: { resolve: vi.fn(async () => null) } });
    await makeVideoAnalyze(deps)(payload());
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(handoffToConversation).toHaveBeenCalledOnce();
  });

  it("visão FALHA (null) SEM legenda → aviso honesto (fast-path)", async () => {
    const { deps, send, complete, handoffToConversation } = makeDeps({ vision: { resolve: vi.fn(async () => null) } });
    await makeVideoAnalyze(deps)(payload({ caption: null }));
    expect(complete).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(handoffToConversation).not.toHaveBeenCalled();
  });

  it("sem bytes → avisa honesto, sem visão e SEM encaminhar (não há asset); libera o hold", async () => {
    const { deps, send, resolve, handoffToConversation, releaseHold } = makeDeps({ messaging: { fetchMediaBase64: vi.fn(async () => null) } });
    await makeVideoAnalyze(deps)(payload());
    expect(resolve).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(handoffToConversation).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledOnce();
  });

  it("30MB (>modelo, <intake) + legenda → ENCAMINHA (o intake salva o asset; o Grafo B age)", async () => {
    const big = Buffer.alloc(30 * 1024 * 1024).toString("base64");
    const { deps, resolve, send, handoffToConversation } = makeDeps({ messaging: { fetchMediaBase64: vi.fn(async () => big) } });
    await makeVideoAnalyze(deps)(payload());
    expect(resolve).not.toHaveBeenCalled(); // grande demais pra visão ao vivo
    expect(send).not.toHaveBeenCalled();
    expect(handoffToConversation).toHaveBeenCalledOnce();
  });

  it("30MB SEM legenda → promete a biblioteca (honesto), sem encaminhar", async () => {
    const big = Buffer.alloc(30 * 1024 * 1024).toString("base64");
    const { deps, resolve, send, handoffToConversation } = makeDeps({ messaging: { fetchMediaBase64: vi.fn(async () => big) } });
    await makeVideoAnalyze(deps)(payload({ caption: null }));
    expect(resolve).not.toHaveBeenCalled();
    const [, msg] = send.mock.calls[0]!;
    expect(msg).toContain("guardei na biblioteca");
    expect(handoffToConversation).not.toHaveBeenCalled();
  });

  it("60MB (>intake) + legenda → aponta o site, SEM encaminhar (o intake rejeita → não há asset); libera o hold", async () => {
    const huge = Buffer.alloc(60 * 1024 * 1024).toString("base64");
    const { deps, resolve, send, handoffToConversation, releaseHold } = makeDeps({ messaging: { fetchMediaBase64: vi.fn(async () => huge) } });
    await makeVideoAnalyze(deps)(payload());
    expect(resolve).not.toHaveBeenCalled();
    const [, msg] = send.mock.calls[0]!;
    expect(msg).toContain("no site");
    expect(msg).not.toContain("biblioteca e a análise");
    expect(handoffToConversation).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledOnce();
  });

  it("probe fileLength 30MB (>modelo, <intake) + legenda → encaminha ANTES de baixar (sem fetch)", async () => {
    const { deps, fetchMediaBase64, handoffToConversation } = makeDeps();
    await makeVideoAnalyze(deps)(payload({ fileLength: 30 * 1024 * 1024 }));
    expect(fetchMediaBase64).not.toHaveBeenCalled();
    expect(handoffToConversation).toHaveBeenCalledOnce();
  });

  it("probe fileLength 60MB (>intake) → aponta o site ANTES de baixar, sem encaminhar", async () => {
    const { deps, send, fetchMediaBase64, handoffToConversation } = makeDeps();
    await makeVideoAnalyze(deps)(payload({ fileLength: 60 * 1024 * 1024 }));
    expect(fetchMediaBase64).not.toHaveBeenCalled();
    const [, msg] = send.mock.calls[0]!;
    expect(msg).toContain("no site");
    expect(handoffToConversation).not.toHaveBeenCalled();
  });

  it("passa meta.orgId à visão p/ o custo da análise ser metrado (§11)", async () => {
    const { deps, resolve } = makeDeps();
    await makeVideoAnalyze(deps)(payload({ orgId: "org-42" }));
    const arg = resolve.mock.calls[0]![0] as { meta?: { orgId?: string } };
    expect(arg.meta?.orgId).toBe("org-42");
  });

  it("erro do LLM na redação (sem legenda) → aviso honesto (não quebra)", async () => {
    const complete = vi.fn(async () => {
      throw new LLMProviderError("upstream", "timeout");
    });
    const { deps, send } = makeDeps({ llm: { complete } as unknown as VideoAnalyzeDeps["llm"] });
    await makeVideoAnalyze(deps)(payload({ caption: null }));
    expect(send).toHaveBeenCalledOnce();
  });

  it("sem legenda → usa a pergunta padrão ('o que você acha')", async () => {
    const { deps, complete } = makeDeps();
    await makeVideoAnalyze(deps)(payload({ caption: null }));
    const messages = (complete.mock.calls[0]![0] as { messages: { content: string }[] }).messages;
    expect(messages[1]!.content).toContain("O que você acha");
  });
});
