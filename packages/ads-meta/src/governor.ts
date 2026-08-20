import type { Redis } from "ioredis";
import type { BusinessUseCaseUsage } from "./client.js";

/**
 * Governor de rate-limit da Meta — versão **mínimo-correta** (§7 do CLAUDE.md).
 *
 * - Lê o uso reportado (`X-Business-Use-Case-Usage`) via `observeUsage` e, ao passar
 *   do threshold, marca um **cooldown** por ad_account no Redis (TTL = tempo estimado
 *   de destravamento reportado pela Meta, que vem em MINUTOS → convertido p/ segundos).
 * - `acquire` = pass-through **ciente de cooldown**: concede, salvo se há cooldown
 *   ativo → sinaliza degradação graciosa (o adapter roda parcial).
 * - `backoffDelayMs` full-jitter p/ retry após código transitório.
 * - `chunkForBatch` particiona ids (usado via `?ids=`; Batch API real = follow-up).
 *
 * DEFERIDO (follow-up quando o volume exigir): token-bucket atômico (Lua) em `acquire`
 * e o Batch API em `client.batch`. O core nunca fala com o governor direto.
 */

// Backoff full-jitter: espera aleatória em [0, min(cap, base·2^n)).
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 60_000;
// Cooldown default quando a Meta sinaliza throttle sem informar o tempo.
const DEFAULT_COOLDOWN_SEC = 300;
// Uso saturado (%) que, por si só, dispara cooldown mesmo sem tempo reportado.
const MAX_USAGE_PCT = 100;
// TTL do último uso observado (a chave é reescrita a cada chamada).
const USAGE_KEY_TTL_SEC = 600;
// Chave lida pela camada de scheduler no worker (jitter/stagger).
const USAGE_KEY_PREFIX = "meta:usage";
/**
 * Teto de espera "inline" dentro de um run. Acima disso, esperar é pior que degradar:
 * a Meta sinaliza cooldown em minutos → não seguramos o worker; degradamos gracioso
 * (análise parcial). Só esperas curtas (transientes) valem retry dentro do run.
 */
export const MAX_INLINE_WAIT_MS = 5_000;

/**
 * Decide, diante de um rate-limit, se o run deve **degradar** (virar parcial) em vez de
 * esperar+retry inline. PURO (sem IO). `retryAfterMs` indefinido = 1º hit sem cooldown
 * estabelecido → vale retry curto; espera acima do teto = cooldown longo → degrada.
 */
export function shouldDegrade(retryAfterMs?: number): boolean {
  return retryAfterMs !== undefined && retryAfterMs > MAX_INLINE_WAIT_MS;
}

export interface GovernorOptions {
  readonly redis: Redis;
  /** prefixo das chaves Redis do governor. */
  readonly keyPrefix?: string;
  /** fonte de aleatoriedade do jitter (injetável p/ teste determinístico). */
  readonly rng?: () => number;
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
  private readonly keyPrefix: string;
  private readonly rng: () => number;

  constructor(options: GovernorOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? "meta:gov";
    this.rng = options.rng ?? Math.random;
  }

  /**
   * Pass-through ciente de cooldown: concede, salvo se há cooldown ativo p/ a conta
   * (marcado por `observeUsage` ao passar do threshold) → nega + sinaliza degradação.
   */
  async acquire(adAccountId: string): Promise<AcquireResult> {
    const pttl = await this.redis.pttl(this.cooldownKey(adAccountId));
    if (pttl > 0) return { granted: false, retryAfterMs: pttl, degrade: true };
    return { granted: true, retryAfterMs: 0, degrade: false };
  }

  /**
   * Consome o uso reportado: persiste o pico (chave lida pelo scheduler p/ pacing) e
   * marca cooldown **só quando a Meta realmente sinaliza throttle** — tempo de
   * destravamento reportado (`min > 0`) ou uso saturado (100%). NÃO trava proativo a
   * 80%: isso degradaria a análise sem bloqueio real; a pacing proativa vive no
   * scheduler (que lê `meta:usage:*`). TTL do cooldown = min→seg (ou default).
   */
  async observeUsage(adAccountId: string, usage: BusinessUseCaseUsage): Promise<void> {
    const maxPct = Math.max(usage.callCountPct, usage.totalCputimePct, usage.totalTimePct);
    await this.redis.set(this.usageKey(adAccountId), String(maxPct), "EX", USAGE_KEY_TTL_SEC);
    const min = usage.estimatedTimeToRegainAccessMin;
    const throttled = (min !== undefined && min > 0) || maxPct >= MAX_USAGE_PCT;
    if (throttled) {
      const cooldownSec = min && min > 0 ? Math.ceil(min * 60) : DEFAULT_COOLDOWN_SEC;
      await this.redis.set(this.cooldownKey(adAccountId), "1", "EX", cooldownSec);
    }
  }

  /** Backoff full-jitter: espera aleatória em [0, min(cap, base·2^attempt)). */
  backoffDelayMs(attempt: number): number {
    const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.floor(this.rng() * exp);
  }

  /** Particiona ids em lotes de no máx `size` (default 50; usado via `?ids=`). */
  chunkForBatch<T>(items: readonly T[], size = 50): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
  }

  private cooldownKey(adAccountId: string): string {
    return `${this.keyPrefix}:cooldown:${adAccountId}`;
  }

  private usageKey(adAccountId: string): string {
    return `${USAGE_KEY_PREFIX}:${adAccountId}`;
  }
}
