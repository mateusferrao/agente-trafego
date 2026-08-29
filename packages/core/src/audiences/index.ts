// Helpers puros de PÚBLICO (Fatia 7). O match nome→id reusa `resolveNamedMatch` (core);
// aqui vai só a heurística de EXCLUSÃO de convertidos (remarketing limpo). Sem IO.

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
