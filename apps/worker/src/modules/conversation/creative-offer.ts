// Ponte estado→turno da Slice 7 (criativo pelo WhatsApp): o intake de mídia é um side-effect
// (não roda o Grafo B), então guarda uma OFERTA efêmera no Redis (TTL) keyed pela conversa; o
// próximo turno (turn.ts) lê ANTES do grafo e, num "sim" determinístico, resolve — troca o
// criativo do rascunho pendente ('use') ou propõe criar uma campanha com o criativo ('create').
// Não escreve no checkpoint do LangGraph por fora (hacky); a oferta é uma fonte à parte.

import type { Redis } from "ioredis";

/** Oferta pendente após o usuário mandar um criativo no WhatsApp. `draftId` presente → há um
 *  rascunho pra USAR o criativo; ausente → oferta de CRIAR uma campanha com ele. */
export interface CreativeOffer {
  readonly assetId: string;
  readonly draftId?: string;
}

/** TTL da oferta (s) — janela curta pro "sim". Some sozinha se o usuário não responder. */
const OFFER_TTL_SECONDS = 30 * 60;
const keyOf = (conversationId: string): string => `creative-offer:${conversationId}`;

export async function setCreativeOffer(redis: Redis, conversationId: string, offer: CreativeOffer): Promise<void> {
  await redis.set(keyOf(conversationId), JSON.stringify(offer), "EX", OFFER_TTL_SECONDS);
}

export async function getCreativeOffer(redis: Redis, conversationId: string): Promise<CreativeOffer | null> {
  const raw = await redis.get(keyOf(conversationId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CreativeOffer;
    return parsed.assetId ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearCreativeOffer(redis: Redis, conversationId: string): Promise<void> {
  await redis.del(keyOf(conversationId));
}

/** Afirmação simples e inequívoca ("sim", "pode", "usa", "cria"…) — determinístico (§8: só o
 *  claro resolve; ambíguo cai no turno normal e a oferta segue no TTL). Curta pra não confundir
 *  uma frase longa (ex: "sim, mas muda o budget") com um OK puro — essa vai pro turno normal. */
const AFFIRM_RE = /^(sim|isso|pode ser|pode|manda|usa|use|cria|criar|quero|vamos|bora|ok|beleza|blz|👍|✅)[\s!.]*$/iu;
export function isSimpleAffirmation(text: string): boolean {
  return AFFIRM_RE.test(text.trim());
}
