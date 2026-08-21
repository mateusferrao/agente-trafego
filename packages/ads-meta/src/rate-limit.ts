import { sleep } from "@trafego/shared";
import { MetaApiError, type BusinessUseCaseUsage } from "./client.js";
import { stripActPrefix } from "./ids.js";

/**
 * Helpers compartilhados de rate-limit/governor (antes duplicados entre o path de
 * insights e o wrapper de leituras): código+erro de cooldown e resolução do uso
 * reportado. PUROS (sem estado).
 */

/** Code BUC de rate-limit usado ao sinalizar cooldown ativo (→ `rate_limited` na casca). */
export const COOLDOWN_CODE = 80000;

/** Erro padrão de cooldown ativo (fonte única — mesma mensagem/código nos dois paths). */
export function cooldownError(): MetaApiError {
  return new MetaApiError("rate-limit: cooldown ativo", COOLDOWN_CODE, undefined, 429);
}

export { sleep };

/**
 * Resolve o uso reportado da conta (o header BUC é keyed pelo id cru). Tenta id
 * normalizado, depois sem prefixo; só cai no "primeiro valor" quando há **uma única**
 * conta no mapa — evita atribuir o uso de OUTRA conta num response multi-conta.
 */
export function pickUsage(
  usage: Readonly<Record<string, BusinessUseCaseUsage>> | undefined,
  accountId: string,
): BusinessUseCaseUsage | undefined {
  if (!usage) return undefined;
  const direct = usage[accountId] ?? usage[stripActPrefix(accountId)];
  if (direct) return direct;
  const keys = Object.keys(usage);
  return keys.length === 1 ? usage[keys[0]!] : undefined;
}
