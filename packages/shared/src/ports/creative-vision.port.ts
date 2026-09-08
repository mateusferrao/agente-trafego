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
   * Vídeo COMPLETO (data-url base64 ou URL) p/ um modelo video-capable — análise "do jeito certo"
   * (movimento/áudio/gancho), sem depender de frames da Meta. Quando presente, o resolver manda o
   * vídeo em vez dos frames e roteia pro modelo de vídeo. Ausente → usa `imageUrls` (fallback).
   */
  readonly videoUrl?: string;
  /**
   * Hash do conteúdo — chave do cache. Deriva de um id ESTÁVEL do criativo
   * (id/video), NÃO da URL do fbcdn (que rotaciona a assinatura a cada fetch e
   * furaria o cache). Muda só quando o criativo/analisador muda.
   */
  readonly contentHash: string;
  /** texto do criativo (título/corpo/CTA), quando disponível. */
  readonly copy?: string;
  /**
   * metering POR-CHAMADA (atribuição do custo da visão à org/run) — o `orgId` varia por job, então
   * quando o resolver é construído sem `meta` fixo (ex: worker de análise de vídeo do WhatsApp), a
   * chamada passa o seu aqui. Tem precedência sobre o `meta` de construção do resolver.
   */
  readonly meta?: { readonly orgId?: string; readonly runId?: string };
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
