// Governor de rate-limit — nível TENANT/SCHEDULER (jitter/stagger).
//
// NOTA: o governor de VERDADE (token-bucket por ad_account que lê os headers
// `X-Business-Use-Case-Usage` da Graph API, Batch ≤50, async report jobs,
// backoff) vive DENTRO do adapter `@trafego/ads-meta` — é ele quem fala com a
// Meta e conhece os headers. Este módulo é só a camada de agendamento: espalhar
// os crons entre contas p/ não estourar o limite de forma coordenada (CLAUDE §7).
//
// TODO: mover/duplicar nada — quando o adapter existir, este arquivo só calcula
// jitter e (opcionalmente) consulta o bucket compartilhado (Redis) p/ decidir
// adiar um disparo.

import type { Redis } from "ioredis";

export interface TokenBucketConfig {
  /** capacidade máxima de tokens (janela). */
  readonly capacity: number;
  /** tokens repostos por segundo. */
  readonly refillPerSec: number;
}

/**
 * Token-bucket por ad_account (backing Redis, compartilhado com o adapter Meta).
 * Aqui só usamos p/ decidir se ADIAMOS um disparo agendado (não p/ chamadas HTTP).
 */
export class AdAccountRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly config: TokenBucketConfig,
  ) {}

  /** Tenta consumir 1 token; retorna false se sem saldo (deve adiar/jitter). */
  async tryAcquire(adAccountId: string): Promise<boolean> {
    void this.redis;
    void this.config;
    void adAccountId;
    // TODO: script Lua atômico (GET/refill/DECR) na key `ratebucket:${adAccountId}`.
    return true;
  }

  /** Lê o uso reportado pela Meta (headers) que o adapter grava no Redis. */
  async currentUsagePct(adAccountId: string): Promise<number> {
    void adAccountId;
    // TODO: ler `meta:usage:${adAccountId}` (populado pelo @trafego/ads-meta a partir de
    //       X-Business-Use-Case-Usage). Base p/ degradação graciosa.
    return 0;
  }
}

/** Jitter determinístico-por-conta p/ stagger dos crons (evita pico simultâneo). */
export function jitterForAccount(adAccountId: string, maxMs: number): number {
  let h = 0;
  for (let i = 0; i < adAccountId.length; i++) h = (h * 31 + adAccountId.charCodeAt(i)) >>> 0;
  return h % Math.max(1, maxMs);
}
