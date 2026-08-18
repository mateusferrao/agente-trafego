import type { Redis } from "ioredis";
import type { BusinessUseCaseUsage } from "./client.js";

/**
 * Governor de rate-limit da Meta (§7 do CLAUDE.md).
 *
 * - Token-bucket **por ad_account** persistido em Redis (compartilhado entre api/worker).
 * - Lê o uso reportado (`X-Business-Use-Case-Usage`) p/ frear antes do 429.
 * - Backoff + jitter; Batch API ≤50; degradação graciosa (roda parcial).
 *
 * O core nunca fala com o governor direto — o adapter chama `acquire` antes de cada
 * grupo de chamadas e `observeUsage` após ler os headers.
 */

export interface GovernorOptions {
  readonly redis: Redis;
  /** capacidade do balde por ad_account. */
  readonly bucketCapacity?: number;
  /** tokens repostos por segundo. */
  readonly refillPerSec?: number;
  /** % de uso reportado a partir do qual entra em degradação. */
  readonly usageThresholdPct?: number;
  /** prefixo das chaves Redis. */
  readonly keyPrefix?: string;
}

export interface AcquireResult {
  readonly granted: boolean;
  /** ms a esperar caso não concedido (backoff sugerido). */
  readonly retryAfterMs: number;
  /** true quando o adapter deve rodar em modo parcial/cache. */
  readonly degrade: boolean;
}

export class MetaGovernor {
  private readonly redis: Redis;
  private readonly bucketCapacity: number;
  private readonly refillPerSec: number;
  private readonly usageThresholdPct: number;
  private readonly keyPrefix: string;

  constructor(options: GovernorOptions) {
    this.redis = options.redis;
    this.bucketCapacity = options.bucketCapacity ?? 200;
    this.refillPerSec = options.refillPerSec ?? 5;
    this.usageThresholdPct = options.usageThresholdPct ?? 80;
    this.keyPrefix = options.keyPrefix ?? "meta:gov";
  }

  /** Tenta consumir `cost` tokens do balde da conta (token-bucket atômico via Lua). */
  acquire(adAccountId: string, cost = 1): Promise<AcquireResult> {
    // TODO: script Lua (refill + consume) em EVALSHA; sem tokens → granted:false + backoff.
    throw new Error("not implemented");
  }

  /** Atualiza o estado do balde a partir do uso reportado pela Meta. */
  observeUsage(adAccountId: string, usage: BusinessUseCaseUsage): Promise<void> {
    // TODO: se algum pct >= threshold → drenar balde + marcar cooldown (degradação).
    throw new Error("not implemented");
  }

  /** Backoff exponencial com jitter (full jitter) p/ retry após 429/limite. */
  backoffDelayMs(attempt: number): number {
    // TODO: min(cap, base * 2^attempt) com jitter aleatório.
    throw new Error("not implemented");
  }

  /** Particiona ids em lotes de no máx `size` (default 50 = limite do Batch API). */
  chunkForBatch<T>(items: readonly T[], size = 50): T[][] {
    // TODO: particionar respeitando o teto de 50 sub-requests por HTTP.
    throw new Error("not implemented");
  }
}
