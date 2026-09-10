// Resolução determinística da RESPOSTA do usuário a uma desambiguação numerada
// ("Qual desses? 1... 2... 3..."). Fixa o bug do "1" virar outra intenção: em vez de o
// LLM reconstruir a escolha (e escorregar pra regra mais saliente), a casca congela as
// opções e ESTE resolvedor puro casa a resposta → índice OU nome (reusa resolveNamedMatch).
// Conservador: só resolve quando a resposta É a escolha; qualquer coisa fora → `unresolved`
// (o turno segue pro LLM normal). PURO — sem IO. §13 reuso-primeiro (sem matcher paralelo).

import { normalizeName, resolveNamedMatch } from "./index.js";

/** Uma opção congelada no gate: a posição mostrada (`index`, 1-based), o id externo/opaco
 *  já resolvido (interesse/campanha/página) e o rótulo exibido. */
export interface DisambiguationOption {
  readonly index: number;
  readonly id: string;
  readonly name: string;
}

export type DisambiguationChoice =
  | { readonly kind: "resolved"; readonly option: DisambiguationOption }
  | { readonly kind: "unresolved" };

/** Ordinais por extenso até 5 (o teto de sugestões é `MAX_SUGGESTIONS`=5). Acento já removido. */
const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  primeiro: 1,
  primeira: 1,
  segundo: 2,
  segunda: 2,
  terceiro: 3,
  terceira: 3,
  quarto: 4,
  quarta: 4,
  quinto: 5,
  quinta: 5,
};

/** "1", "opcao 2", "o 3", "n 2", "#2", "2)", "2." — a resposta É só o número (opcionalmente
 *  precedido de artigo/rótulo). Frase com o número no meio ("muda pra 100") NÃO casa (o `$`
 *  exige que o número seja o conteúdo). */
const INDEX_RE = /^(?:(?:a|o|as|os|opcao|numero|num|n|item)\s*)?[#nº°]?\s*(\d{1,3})\s*[)\.:º°]?$/u;

/** Índice escolhido (1-based) dentro da faixa `[1, max]`, ou `null` (não é escolha por índice). */
function parseIndex(userText: string, max: number): number | null {
  const t = normalizeName(userText); // caixa/acento/espaço/zero-à-esquerda normalizados
  const ordinal = ORDINAL_WORDS[t.replace(/^(?:a|o|as|os)\s+/u, "")];
  const digits = INDEX_RE.exec(t);
  const idx = ordinal ?? (digits ? Number(digits[1]) : NaN);
  return Number.isInteger(idx) && idx >= 1 && idx <= max ? idx : null;
}

/**
 * Casa a resposta do usuário às opções congeladas. Ordem: (1) por ÍNDICE — o número/ordinal
 * é a escolha, mesmo quando o id da opção é numérico (por isso índice ANTES de nome); (2) por
 * NOME via `resolveNamedMatch` (typo/acento tolerados, autoescolha só com folga). Ambíguo/none
 * → `unresolved` (o gate pergunta de novo / segue pro LLM). Nunca chuta sob incerteza (§8).
 */
export function resolveDisambiguationChoice(
  options: readonly DisambiguationOption[],
  userText: string,
): DisambiguationChoice {
  if (options.length === 0) return { kind: "unresolved" };

  const idx = parseIndex(userText, options.length);
  if (idx !== null) {
    const option = options.find((o) => o.index === idx);
    if (option) return { kind: "resolved", option };
  }

  const byName = resolveNamedMatch(options, userText, { name: (o: DisambiguationOption) => o.name });
  if (byName.kind === "one") return { kind: "resolved", option: byName.row };
  return { kind: "unresolved" };
}
