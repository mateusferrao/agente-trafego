// Dedupe ATÔMICO do inbound (D2): o webhook da Evolution pode reentregar a MESMA mensagem. O
// dedupe antigo era read-then-write (checa `messages.meta->>messageId`, grava depois) — sem índice
// único e não-atômico: sob >1 réplica do worker, duas entregas simultâneas passavam as duas (→
// transcrição/cobrança/escrita em dobro). `SET NX` no Redis reivindica o messageId de forma atômica
// ANTES de qualquer trabalho, seguro entre réplicas.

import type { Redis } from "ioredis";

/** Janela de reentrega do provider — folgada (24h). O custo é 1 chave curta por mensagem. */
const DEDUPE_TTL_SEC = 24 * 60 * 60;
const keyOf = (instanceId: string, messageId: string): string => `wa:dedup:${instanceId}:${messageId}`;

/**
 * Reivindica o processamento de um `messageId` (por instância) de forma atômica. `true` = 1ª vez
 * (siga o processamento); `false` = já visto (duplicata → ignore). Substitui o read-then-write.
 *
 * CUIDADO ao adicionar retry na fila inbound: o claim é UPFRONT (antes do trabalho), então um job
 * que reivindicou e depois falhou NÃO reprocessa no retry (a chave já está reivindicada) — hoje é
 * seguro porque a `WHATSAPP_INBOUND_QUEUE` roda com `attempts=1` (sem retry): crash = perde a
 * mensagem (fecha-fechado, mesmo comportamento do dedupe antigo). Se um dia a fila ganhar retry,
 * mover o claim p/ DEPOIS do trabalho (ou liberar a chave em falha) — senão o retry vira no-op.
 */
export async function claimInbound(redis: Redis, instanceId: string, messageId: string): Promise<boolean> {
  const res = await redis.set(keyOf(instanceId, messageId), "1", "EX", DEDUPE_TTL_SEC, "NX");
  return res === "OK";
}
