import { describe, expect, it, vi } from "vitest";
import { TranscriptionError } from "@trafego/shared/ports";
import { OpenRouterTranscriptionAdapter, toFormat } from "./transcription.adapter.js";

describe("toFormat", () => {
  it("mapeia mimes comuns (com/sem params) para o format do OpenRouter", () => {
    expect(toFormat("audio/ogg; codecs=opus")).toBe("ogg"); // voz WhatsApp
    expect(toFormat("audio/ogg")).toBe("ogg");
    expect(toFormat("audio/mpeg")).toBe("mp3");
    expect(toFormat("audio/mpga")).toBe("mp3");
    expect(toFormat("audio/x-m4a")).toBe("m4a");
    expect(toFormat("audio/mp4")).toBe("mp4");
    expect(toFormat("audio/wav")).toBe("wav");
    expect(toFormat("audio/x-wav")).toBe("wav");
    expect(toFormat("audio/wave")).toBe("wav");
    expect(toFormat("audio/webm")).toBe("webm");
    expect(toFormat("audio/aac")).toBe("aac");
    expect(toFormat("audio/x-aac")).toBe("aac");
  });

  it("normaliza caixa e espaços", () => {
    expect(toFormat("AUDIO/OGG")).toBe("ogg");
    expect(toFormat("  audio/ogg ")).toBe("ogg");
  });

  it("subtipo desconhecido passa direto (sem o prefixo audio/)", () => {
    expect(toFormat("audio/amr")).toBe("amr");
    expect(toFormat("audio/flac")).toBe("flac");
  });
});

const OPTS = { apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-large-v3-turbo" };
const BYTES = new Uint8Array([104, 105]); // "hi"
const BYTES_B64 = "aGk=";

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
}
function errResponse(status: number, body = "erro"): Response {
  return { ok: false, status, json: async () => ({}), text: async () => body } as unknown as Response;
}

describe("OpenRouterTranscriptionAdapter.transcribe", () => {
  it("monta a request certa e extrai texto+custo+duração", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({ text: " olá ", model: "openai/whisper-large-v3-turbo", usage: { cost: 0.0005, seconds: 9.2, total_tokens: 113 } }),
    );
    const adapter = new OpenRouterTranscriptionAdapter({ ...OPTS, fetchFn });

    const result = await adapter.transcribe({ bytes: BYTES, mimetype: "audio/ogg; codecs=opus", language: "pt" });

    expect(result).toEqual({ text: "olá", model: "openai/whisper-large-v3-turbo", costUsd: 0.0005, durationSec: 9.2, tokensUsed: 113 });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer k");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      model: "openai/whisper-large-v3-turbo",
      input_audio: { data: BYTES_B64, format: "ogg" },
      language: "pt",
      usage: { include: true },
    });
  });

  it("custo ausente ≠ zero: omite costUsd", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ text: "oi", usage: { seconds: 1 } }));
    const adapter = new OpenRouterTranscriptionAdapter({ ...OPTS, fetchFn });
    const result = await adapter.transcribe({ bytes: BYTES, mimetype: "audio/ogg" });
    expect(result.costUsd).toBeUndefined();
    expect(result.text).toBe("oi");
    expect(result.model).toBe("openai/whisper-large-v3-turbo"); // fallback ao configurado
  });

  it("sem language não manda o campo", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ text: "x" }));
    const adapter = new OpenRouterTranscriptionAdapter({ ...OPTS, fetchFn });
    await adapter.transcribe({ bytes: BYTES, mimetype: "audio/ogg" });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.language).toBeUndefined();
  });

  it("mapeia erros HTTP para TranscriptionError tipado", async () => {
    const cases: Array<[number, string]> = [
      [400, "unsupported_format"],
      [415, "unsupported_format"],
      [413, "too_large"],
      [500, "upstream"],
      [502, "upstream"],
    ];
    for (const [status, kind] of cases) {
      const fetchFn = vi.fn().mockResolvedValue(errResponse(status));
      const adapter = new OpenRouterTranscriptionAdapter({ ...OPTS, fetchFn });
      await expect(adapter.transcribe({ bytes: BYTES, mimetype: "audio/ogg" })).rejects.toMatchObject({
        name: "TranscriptionError",
        kind,
      });
    }
  });

  it("falha de rede → upstream", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const adapter = new OpenRouterTranscriptionAdapter({ ...OPTS, fetchFn });
    await expect(adapter.transcribe({ bytes: BYTES, mimetype: "audio/ogg" })).rejects.toMatchObject({ kind: "upstream" });
  });

  it("abort (timeout) → timeout", async () => {
    const fetchFn = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const adapter = new OpenRouterTranscriptionAdapter({ ...OPTS, fetchFn });
    await expect(adapter.transcribe({ bytes: BYTES, mimetype: "audio/ogg" })).rejects.toMatchObject({ kind: "timeout" });
    expect(TranscriptionError).toBeDefined();
  });
});
