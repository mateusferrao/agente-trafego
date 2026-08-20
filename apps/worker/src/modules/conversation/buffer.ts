// Buffer de mensagens inbound por conversa (debounce 5b-2.4). O inbound acumula os
// fragmentos aqui e agenda um flush atrasado; o flush drena tudo num turno só.

import type { Redis } from "ioredis";

const BUFFER_PREFIX = "wa:inbuf:";

function key(conversationId: string): string {
  return `${BUFFER_PREFIX}${conversationId}`;
}

/** Acumula um fragmento; renova a expiração (janela + margem) p/ não vazar chaves. */
export async function pushInbound(
  redis: Redis,
  conversationId: string,
  text: string,
  ttlSec: number,
): Promise<void> {
  const k = key(conversationId);
  await redis.rpush(k, text);
  await redis.expire(k, ttlSec);
}

/** Drena (lê + apaga) os fragmentos acumulados, em ordem. Vazio = já drenado. */
export async function drainInbound(redis: Redis, conversationId: string): Promise<string[]> {
  const k = key(conversationId);
  const items = await redis.lrange(k, 0, -1);
  if (items.length > 0) await redis.del(k);
  return items;
}
