import type { Redis } from "ioredis";
import type { AdEntity, EntityLevel } from "@trafego/shared/types";

/**
 * Cache do CATÁLOGO de entidades (campaign/adset/ad) por ad_account, no Redis.
 *
 * Motivação (§7 governor / ROADMAP): `listEntities` re-baixava os 3 níveis (ad =
 * centenas paginado) a CADA run — a maior fonte de pressão de rate-limit. As métricas
 * já são incrementais (snapshots); só faltava reusar o catálogo entre runs.
 *
 * Invalidação: TTL curto + **DEL na escrita real** (pausar/budget/undo mudam o estado
 * da entidade → o catálogo da conta é derrubado; a próxima run re-lista fresco). Dry-run
 * não invalida (não muda nada). `ttlSec <= 0` desliga o cache (sempre lista fresco).
 */

const KEY_PREFIX = "meta:entities";
/** Níveis cacheados (fixos) — usados p/ invalidar sem `SCAN`. */
const LEVELS: readonly EntityLevel[] = ["campaign", "adset", "ad"];

export interface EntityCacheOptions {
  readonly redis: Redis;
  /** validade do catálogo em segundos; `<= 0` desliga o cache. */
  readonly ttlSec: number;
  readonly keyPrefix?: string;
}

export class MetaEntityCache {
  private readonly redis: Redis;
  private readonly ttlSec: number;
  private readonly keyPrefix: string;

  constructor(options: EntityCacheOptions) {
    this.redis = options.redis;
    this.ttlSec = options.ttlSec;
    this.keyPrefix = options.keyPrefix ?? KEY_PREFIX;
  }

  get enabled(): boolean {
    return this.ttlSec > 0;
  }

  /** Catálogo cacheado do nível (ou `null` = miss / cache off / JSON corrompido). */
  async get(accountId: string, level: EntityLevel): Promise<AdEntity[] | null> {
    if (!this.enabled) return null;
    const raw = await this.redis.get(this.key(accountId, level));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AdEntity[];
    } catch {
      return null; // corrompido → trata como miss (re-lista)
    }
  }

  /** Grava o catálogo do nível com TTL. No-op se o cache estiver desligado. */
  async set(accountId: string, level: EntityLevel, entities: readonly AdEntity[]): Promise<void> {
    if (!this.enabled) return;
    await this.redis.set(this.key(accountId, level), JSON.stringify(entities), "EX", this.ttlSec);
  }

  /** Derruba o catálogo da conta (todos os níveis) — chamado após escrita real. */
  async invalidate(accountId: string): Promise<void> {
    if (!this.enabled) return;
    await this.redis.del(...LEVELS.map((level) => this.key(accountId, level)));
  }

  private key(accountId: string, level: EntityLevel): string {
    return `${this.keyPrefix}:${accountId}:${level}`;
  }
}
