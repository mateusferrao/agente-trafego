// Match determinístico de NOME → entidade (Fatia 7), genérico. Extraído do foco de conta
// (antes só em tools.ts) p/ reuso: desambiguação de campanha e de público reusam o MESMO
// matcher (sem matcher paralelo, §13 reuso-primeiro). Puro — sem IO.

/** Faixa de diacríticos combinantes (Unicode) removida após NFD. */
const DIACRITIC_MARKS = /[̀-ͯ]/g;

/** Score mínimo (Dice) p/ um candidato ser plausível (mesmo princípio do pg_trgm, threshold 0.3). */
const MIN_MATCH_SCORE = 0.3;
/** Vantagem mínima do 1º sobre o 2º p/ autoescolher sem perguntar. */
const WINNER_MARGIN = 0.15;
/** Teto de sugestões numa ambiguidade (cabe numa mensagem de WhatsApp). */
const MAX_SUGGESTIONS = 5;
/** Score mínimo p/ o ÚNICO candidato plausível se autoescolher sem 2º p/ comparar margem. */
const SOLO_CONFIRM_SCORE = 0.5;
/** Piso garantido por contenção literal (query ⊆ nome, ou vice) — restaura o `ILIKE '%q%'`
 *  que o Dice puro perde quando a query é bem mais curta que o nome (ex: campanhas longas). */
const CONTAINMENT_MATCH_SCORE = 0.9;

/** Normaliza texto p/ comparação: acento, caixa, espaço e zero à esquerda em dígito não importam. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(DIACRITIC_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\d+/g, (run) => String(Number(run)));
}

/** Bigramas de caractere (janela de 2, com espaço — a fronteira de palavra conta pro score). */
function bigramSet(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Similaridade Sørensen–Dice sobre bigramas — mesmo princípio do pg_trgm, sem a extensão. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const setA = bigramSet(a);
  const setB = bigramSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const bg of setA) if (setB.has(bg)) intersection++;
  return (2 * intersection) / (setA.size + setB.size);
}

/** Score query×nome (normalizados) — Dice com piso de contenção literal. */
function nameMatchScore(query: string, name: string): number {
  const dice = diceSimilarity(query, name);
  if (query.length > 0 && name.length > 0 && (name.includes(query) || query.includes(name))) {
    return Math.max(CONTAINMENT_MATCH_SCORE, dice);
  }
  return dice;
}

export type NamedMatch<T> =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly row: T }
  | { readonly kind: "ambiguous"; readonly rows: readonly T[]; readonly omittedCount: number };

export interface NamedMatchAccessors<T> {
  /** nome legível da linha (p/ o match textual). */
  readonly name: (row: T) => string | null;
  /** chaves de identidade p/ match EXATO cru (id externo/opaco) — ex: adAccountId, campaignId. */
  readonly keys?: (row: T) => readonly string[];
}

/**
 * Escolhe a linha por NOME entre candidatos (typo/acento/ordem de palavra toleradas). Chave
 * exata (crua) ou nome normalizado exato ganham direto; senão rankeia por Dice+contenção e só
 * autoescolhe com folga clara (`WINNER_MARGIN`/`SOLO_CONFIRM_SCORE`). Resto = ambíguo,
 * ranqueado e capado (`MAX_SUGGESTIONS`) com `omittedCount`. PURO — a casca numera + ancora o id.
 */
export function resolveNamedMatch<T>(rows: readonly T[], query: string, acc: NamedMatchAccessors<T>): NamedMatch<T> {
  if (rows.length === 0) return { kind: "none" };

  const rawQ = query.trim().toLowerCase();
  if (acc.keys) {
    const idExact = rows.filter((r) => acc.keys!(r).some((k) => typeof k === "string" && k.toLowerCase() === rawQ));
    if (idExact.length === 1) return { kind: "one", row: idExact[0]! };
  }

  const q = normalizeName(query);
  if (q.length === 0) return { kind: "none" };

  const nameExact = rows.filter((r) => normalizeName(acc.name(r) ?? "") === q);
  if (nameExact.length === 1) return { kind: "one", row: nameExact[0]! };

  const scored = rows
    .map((row) => ({ row, score: nameMatchScore(q, normalizeName(acc.name(row) ?? "")) }))
    .filter((c) => c.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: "none" };
  if (scored.length === 1 && scored[0]!.score >= SOLO_CONFIRM_SCORE) return { kind: "one", row: scored[0]!.row };
  if (scored.length >= 2 && scored[0]!.score - scored[1]!.score >= WINNER_MARGIN) return { kind: "one", row: scored[0]!.row };

  const capped = scored.slice(0, MAX_SUGGESTIONS).map((c) => c.row);
  return { kind: "ambiguous", rows: capped, omittedCount: scored.length - capped.length };
}
