import type { TranscriptionResult } from "../types/index.js";

/** Áudio a transcrever: bytes crus + mime vindo do provider de canal. */
export interface TranscriptionInput {
  readonly bytes: Uint8Array;
  /** mime do provider, ex: "audio/ogg; codecs=opus" (params são tolerados). */
  readonly mimetype: string;
  /** dica ISO-639-1 (ex: "pt"); ausente/vazio = auto-detect do provider. */
  readonly language?: string;
}

/**
 * Falha tipada da borda de transcrição — o adapter traduz o erro do provider
 * para esta forma e a casca decide sem conhecer o provider. `upstream`/`timeout`
 * são transitórios (a fila re-tenta); `unsupported_format`/`too_large` são
 * permanentes (retentar o mesmo áudio não adianta).
 */
export type TranscriptionErrorKind = "unsupported_format" | "too_large" | "upstream" | "timeout";

export class TranscriptionError extends Error {
  constructor(
    readonly kind: TranscriptionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

/**
 * Borda de transcrição de áudio (STT). Adapter MVP = OpenRouter
 * (`/audio/transcriptions`, whisper). Retorna `costUsd` real → base do metering
 * (§11). Espelha `CreativeVisionPort`: capacidade de provider atrás de porta
 * própria — trocar de provider = novo adapter, core intocado (§5).
 */
export interface TranscriptionPort {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}
