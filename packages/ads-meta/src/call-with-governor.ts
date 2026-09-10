import { META_TRANSIENT_CODES, MetaApiError, type GraphResponse } from "./client.js";
import { type MetaGovernor, shouldDegrade } from "./governor.js";
import { cooldownError, pickUsage, sleep as defaultSleep } from "./rate-limit.js";

/**
 * Wrapper de resiliência p/ chamadas de LEITURA da Meta (listEntities/getCreatives/status/árvore).
 *
 * Fecha o gap: hoje só o path de insights `acquire`/`observeUsage`/retria. Aqui:
 * - `acquire` ciente de cooldown → cooldown longo (`shouldDegrade`) degrada na hora
 *   (relança rate-limit → a casca marca parcial); espera curta → dorme e segue.
 * - alimenta `observeUsage` com o header BUC de toda chamada — no sucesso E no 429
 *   (o `MetaApiError` propaga o header), pra o governor aprender e não gastar retries.
 * - no 1º erro RETRIÁVEL (rate-limit OU transiente: 5xx / código 1,2 / rede / timeout),
 *   backoff curto + retry inline até `maxRetries`; persistiu → relança (piso = degradação
 *   graciosa). Só LEITURAS usam este wrapper — GETs são seguros de retriar (idempotentes).
 *
 * PARCIAL-RÁPIDO: nunca segura o run por minutos — cooldown de minutos vira parcial.
 */

const DEFAULT_MAX_RETRIES = 2;
const HTTP_SERVER_ERROR_MIN = 500;

export interface CallWithGovernorDeps {
  readonly governor: MetaGovernor;
  /** injetável p/ teste determinístico (default setTimeout). */
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly maxRetries?: number;
}

/** Erro de rede/timeout (não-MetaApiError): `fetch` falhou (TypeError) ou o AbortSignal.timeout disparou. */
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // "fetch failed"
  const name = (error as { readonly name?: unknown } | null | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Vale re-tentar? rate-limit E transiente (5xx / código 1,2 "serviço indisponível" / rede / timeout).
 *  `META_TRANSIENT_CODES` já é superconjunto dos códigos de rate-limit — cobre os dois. Só p/ LEITURA. */
function isRetryable(error: unknown): boolean {
  if (error instanceof MetaApiError) {
    return (error.code !== undefined && META_TRANSIENT_CODES.has(error.code)) || error.httpStatus >= HTTP_SERVER_ERROR_MIN;
  }
  return isNetworkError(error);
}

export async function callWithGovernor<T>(
  accountId: string,
  fn: () => Promise<GraphResponse<T>>,
  deps: CallWithGovernorDeps,
): Promise<T> {
  const { governor, sleepFn = defaultSleep } = deps;
  // guarda: maxRetries não-finito (config equivocada) não pode virar loop infinito.
  const maxRetries = Number.isFinite(deps.maxRetries) ? (deps.maxRetries as number) : DEFAULT_MAX_RETRIES;

  const acquired = await governor.acquire(accountId);
  if (!acquired.granted) {
    if (shouldDegrade(acquired.retryAfterMs)) throw cooldownError();
    await sleepFn(acquired.retryAfterMs); // cooldown quase expirado → dorme o resto e segue
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fn();
      const usage = pickUsage(res.usage, accountId);
      if (usage) await governor.observeUsage(accountId, usage);
      return res.data;
    } catch (error) {
      if (!isRetryable(error) || attempt >= maxRetries) throw error;
      // aprende com o 429: se o erro carrega o header BUC (rate-limit), alimenta o governor (seta
      // cooldown p/ as próximas chamadas/runs) antes do backoff. Transiente puro (5xx/rede) não tem header.
      if (error instanceof MetaApiError) {
        const usage = pickUsage(error.usage, accountId);
        if (usage) await governor.observeUsage(accountId, usage);
      }
      await sleepFn(governor.backoffDelayMs(attempt));
    }
  }
}
