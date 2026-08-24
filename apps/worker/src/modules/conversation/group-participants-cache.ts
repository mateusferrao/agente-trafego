// Cache (Redis, TTL) do mapa LID→telefone dos participantes de um grupo — resolve
// menção/reply endereçada por LID (grupo migrado, `addressingMode: "lid"`) sem bater
// na Evolution a cada mensagem. Participação de grupo muda pouco; self-healing (LID
// fora do cache expirado → refresh natural na próxima chamada, sem invalidação ativa).

import type { Redis } from "ioredis";
import type { ChannelInstanceRef, MessagingChannelPort } from "@trafego/shared/ports";

const CACHE_PREFIX = "evo:group-participants:";

export interface GroupParticipantsCacheDeps {
  readonly redis: Redis;
  readonly messaging: Pick<MessagingChannelPort, "resolveGroupParticipants">;
  readonly ttlSec: number;
}

/** Mapa LID→telefone (E.164) dos participantes do grupo — cache-first, Evolution no miss. */
export async function loadGroupParticipantsMap(
  d: GroupParticipantsCacheDeps,
  instance: ChannelInstanceRef,
  groupJid: string,
): Promise<Record<string, string>> {
  const key = `${CACHE_PREFIX}${groupJid}`;
  const cached = await d.redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as Record<string, string>;
    } catch {
      // cache corrompido (nunca deveria acontecer, gravamos JSON válido) — cai pro refresh.
    }
  }
  const fresh = await d.messaging.resolveGroupParticipants(instance, groupJid);
  await d.redis.set(key, JSON.stringify(fresh), "EX", d.ttlSec);
  return fresh;
}
