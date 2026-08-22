/**
 * Adapter de transcrição via OpenRouter (`POST /audio/transcriptions`, whisper).
 *
 * - `fetch` cru (não passa pelo LangChain) — mesmo shape do repo automato-api.
 * - Auth: header `Authorization: Bearer OPENROUTER_API_KEY`.
 * - `usage: { include: true }` → garante `usage.cost` real p/ o metering (§11).
 * - Sem retry aqui: a fila BullMQ re-tenta só os erros transitórios (§Fluxo).
 * - `fetch` injetável (testes mockam; prod usa o global).
 */

import { TranscriptionError } from "@trafego/shared/ports";
import type { TranscriptionInput, TranscriptionPort } from "@trafego/shared/ports";
import type { TranscriptionResult } from "@trafego/shared/types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 60_000;

/** Normaliza subtipos p/ o `format` esperado pelo OpenRouter (mesmo mapa do automato-api). */
const FORMAT_ALIASES: Readonly<Record<string, string>> = {
  mpeg: "mp3",
  mpga: "mp3",
  "x-m4a": "m4a",
  "x-wav": "wav",
  wave: "wav",
  "x-aac": "aac",
};

export interface OpenRouterTranscriptionOptions {
  readonly apiKey: string; // OPENROUTER_API_KEY
  readonly model: string; // OPENROUTER model id (ex: openai/whisper-large-v3-turbo)
  readonly baseUrl?: string; // default https://openrouter.ai/api/v1
  readonly timeoutMs?: number; // default 60000
  readonly fetchFn?: typeof fetch; // injeção p/ testes
}

/** Deriva o `format` do OpenRouter a partir do mime do canal (params tolerados). */
export function toFormat(mimetype: string): string {
  const subtype = mimetype
    .toLowerCase()
    .trim()
    .split(";")[0]! // descarta params (ex: "; codecs=opus")
    .trim()
    .replace(/^audio\//u, "");
  return FORMAT_ALIASES[subtype] ?? subtype;
}

interface OpenRouterTranscriptionResponse {
  readonly text?: string;
  readonly model?: string;
  readonly duration?: number;
  readonly usage?: {
    readonly cost?: number;
    readonly seconds?: number;
    readonly total_tokens?: number;
  };
}

export class OpenRouterTranscriptionAdapter implements TranscriptionPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenRouterTranscriptionOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/gu, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const url = `${this.baseUrl}/audio/transcriptions`;
    const language = input.language?.trim();
    const body = JSON.stringify({
      model: this.model,
      input_audio: { data: Buffer.from(input.bytes).toString("base64"), format: toFormat(input.mimetype) },
      ...(language ? { language } : {}),
      usage: { include: true },
    });

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new TranscriptionError("timeout", `transcrição excedeu ${this.timeoutMs}ms`);
      }
      throw new TranscriptionError("upstream", `falha de rede ao chamar o OpenRouter: ${String(cause)}`);
    }

    if (!res.ok) throw mapHttpError(res.status, await safeText(res));

    let json: OpenRouterTranscriptionResponse;
    try {
      json = (await res.json()) as OpenRouterTranscriptionResponse;
    } catch (cause) {
      throw new TranscriptionError("upstream", `resposta não-JSON do OpenRouter: ${String(cause)}`);
    }

    const cost = json.usage?.cost;
    const seconds = json.usage?.seconds ?? json.duration;
    return {
      text: (json.text ?? "").trim(),
      model: json.model ?? this.model,
      ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
      ...(typeof seconds === "number" ? { durationSec: seconds } : {}),
      ...(typeof json.usage?.total_tokens === "number" ? { tokensUsed: json.usage.total_tokens } : {}),
    };
  }
}

/** Traduz o status HTTP em `TranscriptionError` (permanente × transitório). */
function mapHttpError(status: number, detail: string): TranscriptionError {
  if (status === 413) return new TranscriptionError("too_large", `413 áudio grande demais: ${detail}`);
  if (status === 400 || status === 415) {
    return new TranscriptionError("unsupported_format", `${status} formato não suportado: ${detail}`);
  }
  return new TranscriptionError("upstream", `${status} upstream: ${detail}`);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<sem corpo>";
  }
}
