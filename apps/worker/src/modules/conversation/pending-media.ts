// Ponte estado→turno da mídia-como-pergunta (B3): quando o usuário manda uma IMAGEM COM LEGENDA,
// o inbound guarda a imagem (data-url) aqui, keyed pela conversa (TTL curto), e enfileira a legenda
// como texto do turno. O turno (turn.ts) lê a mídia ANTES de montar a mensagem e a anexa como
// conteúdo multimodal — o modelo do chat (já multimodal) "vê" a imagem e responde à pergunta.
// Só imagem (síncrona): vídeo processa async (frames só depois de `ready` na Meta) → fica no B1.

import type { Redis } from "ioredis";

/** Imagem anexada ao próximo turno (data-url = pronta pro conteúdo multimodal do LLM). */
export interface PendingTurnMedia {
  readonly dataUrl: string;
  readonly mimetype: string;
}

/** TTL curto: a imagem só serve pro turno imediato (dispara logo após o debounce). */
const PENDING_MEDIA_TTL_SECONDS = 5 * 60;
const keyOf = (conversationId: string): string => `pending-media:${conversationId}`;

export async function stashPendingMedia(redis: Redis, conversationId: string, media: PendingTurnMedia): Promise<void> {
  await redis.set(keyOf(conversationId), JSON.stringify(media), "EX", PENDING_MEDIA_TTL_SECONDS);
}

/** Lê e REMOVE a mídia pendente (consumida por UM turno). Ausente/inválida → null. */
export async function takePendingMedia(redis: Redis, conversationId: string): Promise<PendingTurnMedia | null> {
  const key = keyOf(conversationId);
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  try {
    const parsed = JSON.parse(raw) as PendingTurnMedia;
    return parsed.dataUrl ? parsed : null;
  } catch {
    return null;
  }
}
