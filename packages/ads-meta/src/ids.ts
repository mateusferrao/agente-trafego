/** Normalização do id de ad account da Meta (prefixo `act_`). Fonte única (era
 *  duplicada em adapter/insights). PURO. */

export const AD_ACCOUNT_PREFIX = "act_";

/** Garante o prefixo `act_` (a Graph exige no path). */
export function normalizeAdAccountId(id: string): string {
  return id.startsWith(AD_ACCOUNT_PREFIX) ? id : `${AD_ACCOUNT_PREFIX}${id}`;
}

/** Remove o prefixo `act_` (id "cru" da conta). */
export function stripActPrefix(id: string): string {
  return id.startsWith(AD_ACCOUNT_PREFIX) ? id.slice(AD_ACCOUNT_PREFIX.length) : id;
}
