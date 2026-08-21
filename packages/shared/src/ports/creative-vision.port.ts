import type { CreativeVisionResult } from "../types/index.js";

export interface CreativeVisionInput {
  /** id do criativo (Meta) — chave lógica. */
  readonly creativeId: string;
  /**
   * Frames a analisar (poster-frames): imagem = 1; vídeo = N frames HD espaçados.
   * O resolver manda todos como conteúdo multimodal ao modelo (Fatia 6c).
   */
  readonly imageUrls: readonly string[];
  /**
   * Hash do conteúdo — chave do cache. Deriva de um id ESTÁVEL do criativo
   * (id/video), NÃO da URL do fbcdn (que rotaciona a assinatura a cada fetch e
   * furaria o cache). Muda só quando o criativo/analisador muda.
   */
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
