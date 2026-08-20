import {
  META_RATE_LIMIT_CODES,
  MetaApiError,
  type BusinessUseCaseUsage,
  type GraphResponse,
} from "./client.js";
import { MetaGovernor, shouldDegrade } from "./governor.js";

/**
 * Wrapper de rate-limit p/ chamadas de LEITURA da Meta (listEntities/getCreatives).
 *
 * Fecha o gap: hoje só o path de insights `acquire`/`observeUsage`/retria. Aqui:
 * - `acquire` ciente de cooldown → cooldown longo (`shouldDegrade`) degrada na hora
 *   (relança rate-limit → a casca marca parcial); espera curta → dorme e segue.
 * - alimenta `observeUsage` com o header BUC de toda chamada (governor aprende).
 * - no 1º `rate_limited` (sem cooldown estabelecido), backoff curto + retry inline
 *   até `maxRetries`; persistiu → relança (piso = degradação graciosa).
 *
 * PARCIAL-RÁPIDO: nunca segura o run por minutos — cooldown de minutos vira parcial.
 */

const DEFAULT_MAX_RETRIES = 2;
/** Code de rate-limit BUC usado ao sinalizar cooldown (mapeia p/ `rate_limited`). */
const COOLDOWN_CODE = 80000;

export interface CallWithGovernorDeps {
  readonly governor: MetaGovernor;
  /** injetável p/ teste determinístico (default setTimeout). */
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly maxRetries?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(error: unknown): error is MetaApiError {
  return error instanceof MetaApiError && error.code !== undefined && META_RATE_LIMIT_CODES.has(error.code);
}

/** Resolve o uso reportado da conta (tolera id com/sem prefixo `act_`). */
function pickUsage(
  usage: Readonly<Record<string, BusinessUseCaseUsage>> | undefined,
  accountId: string,
): BusinessUseCaseUsage | undefined {
  if (!usage) return undefined;
  return usage[accountId] ?? usage[accountId.replace("act_", "")] ?? Object.values(usage)[0];
}

export async function callWithGovernor<T>(
  accountId: string,
  fn: () => Promise<GraphResponse<T>>,
  deps: CallWithGovernorDeps,
): Promise<T> {
  const { governor, sleepFn = defaultSleep, maxRetries = DEFAULT_MAX_RETRIES } = deps;

  const acquired = await governor.acquire(accountId);
  if (!acquired.granted) {
    if (shouldDegrade(acquired.retryAfterMs)) {
      throw new MetaApiError("rate-limit: cooldown ativo", COOLDOWN_CODE, undefined, 429);
    }
    await sleepFn(acquired.retryAfterMs);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fn();
      const usage = pickUsage(res.usage, accountId);
      if (usage) await governor.observeUsage(accountId, usage);
      return res.data;
    } catch (error) {
      // rate-limit no 1º hit (sem cooldown): observa o pico via header não é possível aqui
      // (o erro não carrega usage) — decide por retry curto vs. relançar (→ parcial).
      if (!isRateLimit(error) || attempt >= maxRetries) throw error;
      await sleepFn(governor.backoffDelayMs(attempt));
    }
  }
}
