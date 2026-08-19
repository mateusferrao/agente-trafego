import type { CreativeVisionResult } from "../types/index.js";

export interface CreativeVisionInput {
  /** id do criativo (Meta) — chave lógica. */
  readonly creativeId: string;
  /** URL da imagem a analisar (poster-frame quando o criativo é vídeo). */
  readonly imageUrl: string;
  /** hash do conteúdo (imagem + copy) — chave do cache; muda se o criativo mudar. */
  readonly contentHash: string;
  /** texto do criativo (título/corpo/CTA), quando disponível. */
  readonly copy?: string;
}

/**
 * Borda de análise multimodal de criativo (3b-2). O adapter resolve pelo cache
 * (contentHash + versão do analisador) e só chama o LLM de visão em miss — assim
 * "analisar todos os criativos" não repete custo a cada run. Degrada a `null`
 * (timeout / cap / erro) sem quebrar a análise.
 */
export interface CreativeVisionPort {
  resolve(input: CreativeVisionInput): Promise<CreativeVisionResult | null>;
}
