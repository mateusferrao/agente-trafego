// Helpers puros de PÚBLICO (Fatia 7). O match nome→id reusa `resolveNamedMatch` (core);
// aqui vai a heurística de EXCLUSÃO de convertidos (remarketing limpo) + a leitura da
// estimativa de alcance combinado. Sem IO.

import type { DeliveryEstimate } from "@trafego/shared/types";

/** Nomes que denunciam um público de quem JÁ CONVERTEU — candidatos a exclusão no remarketing. */
const CONVERTER_HINTS = ["lead", "compra", "comprad", "client", "agenda", "venda", "checkout", "purchase", "buyer"] as const;

interface AudienceRef {
  readonly id: string;
  readonly name: string;
  readonly isLookalike?: boolean;
}

/** O nome sugere um público de convertidos (lead/compra/cliente/agendamento…)? */
export function isConverterAudienceName(name: string): boolean {
  const lower = name.toLowerCase();
  return CONVERTER_HINTS.some((h) => lower.includes(h));
}

/**
 * Sugere públicos a EXCLUIR num remarketing: os que parecem "já converteu" (pelo nome), que
 * NÃO estão sendo incluídos e NÃO são lookalike (lookalike é frio, não é convertido). Puro —
 * a casca anexa ao rascunho e o eco+confirma deixa o dono ver/tirar. Vazio = nada a sugerir.
 */
export function suggestConverterExclusions(
  audiences: readonly AudienceRef[],
  includeIds: readonly string[],
): string[] {
  const included = new Set(includeIds);
  return audiences
    .filter((a) => !included.has(a.id) && !a.isLookalike && isConverterAudienceName(a.name))
    .map((a) => a.id);
}

/** Piso de alcance diário abaixo do qual um público arrisca não entregar bem (~ nível de custom
 *  audience Meta). Mesma ordem de grandeza do piso por-público, mas aqui é o COMBINADO estimado. */
const MIN_DAILY_REACH = 1000;

/** Número compacto em PT (1500 → "1,5 mil", 25000 → "25 mil", 1_200_000 → "1,2 mi"). */
function humanCount(n: number): string {
  const ptDecimal = (v: number): string => (Math.round(v * 10) / 10).toString().replace(".", ",");
  if (n >= 1_000_000) return `${ptDecimal(n / 1_000_000)} mi`;
  if (n >= 1000) return `${ptDecimal(n / 1000)} mil`;
  return `${Math.round(n)}`;
}

/**
 * Lê a estimativa de alcance COMBINADO (includes − excludes + geo/idade) numa nota honesta pro eco.
 * `ready:false` ou sem contagem → `null` (o caller degrada pro sinal por-público). Abaixo do piso →
 * ⚠️ "pode entregar pouco"; saudável → nota informativa (sem alarme). Puro/testável.
 */
export function describeDeliveryEstimate(estimate: DeliveryEstimate): string | null {
  if (!estimate.ready || estimate.dailyActiveUsers == null) return null;
  const dau = estimate.dailyActiveUsers;
  const human = `~${humanCount(dau)}`;
  if (dau < MIN_DAILY_REACH) {
    return `⚠️ alcance diário estimado pequeno (${human} pessoas/dia) — pode entregar pouco.`;
  }
  return `Alcance estimado: ${human} pessoas ativas/dia com esse público.`;
}
