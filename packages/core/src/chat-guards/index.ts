// Guard SOFT de honestidade do chat (Grafo B, Fatia 7). Análogo ao `analysis-guards`, mas
// NUNCA dropa/reescreve: só sinaliza p/ a casca anexar um caveat. O chat é prosa livre pt-BR
// → policiar número é intrinsecamente lossy; por isso: (1) só checa DINHEIRO e % (contagens
// inteiras = fast-follow, alto falso-positivo); (2) answer-key = UNIÃO de tools+config+
// histórico; (3) normalização multi-interpretação (BR "1.234,56" × US "1234.56") — na dúvida
// NÃO sinaliza. Telefone tem checagem própria (estrutural), porque o bug foi misatribuição.

import { phoneTokensInText } from "@trafego/shared";

const ROUND_2 = 100;
function round2(x: number): number {
  return Math.round(x * ROUND_2) / ROUND_2;
}

/**
 * Interpretações numéricas plausíveis de um token cru (com . e ,). BR (vírgula decimal) e
 * US (ponto decimal) + só-dígitos. Leniente de propósito: mais candidatos = menos falso-
 * positivo no guard soft.
 */
export function parseNumberCandidates(raw: string): number[] {
  const t = raw.replace(/[^\d.,]/g, "");
  if (!/\d/.test(t)) return [];
  const out = new Set<number>();
  const add = (n: number) => {
    if (Number.isFinite(n)) out.add(round2(n));
  };
  // A: ponto decimal, vírgula milhar (US)
  add(Number(t.replace(/,/g, "")));
  // B: vírgula decimal, ponto milhar (BR)
  add(Number(t.replace(/\./g, "").replace(",", ".")));
  // C: só dígitos (inteiro)
  add(Number(t.replace(/[.,]/g, "")));
  return [...out].filter((n) => Number.isFinite(n));
}

/** Adiciona um número ao gabarito: valor 2dp + inteiro (magnitude ≥ 1) — igual ao analysis-guards. */
function addKnown(set: Set<number>, value: number): void {
  set.add(round2(value));
  if (Math.abs(value) >= 1) set.add(Math.round(value));
}

/** Todos os tokens numéricos de um texto (com separadores). */
const NUMBER_TOKEN_RE = /\d[\d.,]*\d|\d/g;

/** Fontes de verdade p/ o gabarito (o que o agente PODE citar sem inventar). */
export interface GroundingSources {
  /** resultados das tools DESTE turno (JSON string das ToolMessages). */
  readonly toolResults: readonly string[];
  /** config do próprio usuário (business_context/guidance/metas/guardrails) — números legítimos. */
  readonly configText: readonly string[];
  /** turnos anteriores (histórico do checkpoint) — números já ditos por tool antes. */
  readonly history?: readonly string[];
}

/** Junta todo número conhecido (tools + config + histórico), multi-interpretação. */
export function collectGroundedNumbers(sources: GroundingSources): Set<number> {
  const known = new Set<number>();
  const eat = (text: string): void => {
    for (const tok of text.match(NUMBER_TOKEN_RE) ?? []) {
      for (const n of parseNumberCandidates(tok)) addKnown(known, n);
    }
  };
  for (const t of sources.toolResults) eat(t);
  for (const t of sources.configText) eat(t);
  for (const t of sources.history ?? []) eat(t);
  return known;
}

export interface UngroundedNumber {
  readonly kind: "money" | "percent";
  readonly raw: string;
}

const MONEY_RE = /R\$\s*[\d.,]+/gi;
const PERCENT_RE = /[\d.,]+\s*%/g;

/** Um token está ancorado se ALGUMA interpretação (2dp ou inteiro) existe no gabarito. */
function isGrounded(raw: string, known: ReadonlySet<number>): boolean {
  const cands = parseNumberCandidates(raw);
  return cands.some((n) => known.has(round2(n)) || (Math.abs(n) >= 1 && known.has(Math.round(n))));
}

/**
 * Sinaliza valores de DINHEIRO e % citados na resposta que não batem com nenhuma fonte.
 * NÃO modifica o texto (a casca decide o caveat). Só as duas classes de menor falso-positivo.
 */
export function flagUngroundedNumbers(replyText: string, known: ReadonlySet<number>): UngroundedNumber[] {
  const issues: UngroundedNumber[] = [];
  for (const raw of replyText.match(MONEY_RE) ?? []) {
    if (!isGrounded(raw, known)) issues.push({ kind: "money", raw: raw.trim() });
  }
  for (const raw of replyText.match(PERCENT_RE) ?? []) {
    if (!isGrounded(raw, known)) issues.push({ kind: "percent", raw: raw.trim() });
  }
  return issues;
}

/**
 * Checagem ESTRUTURAL de telefone (a raiz do bug): um telefone na resposta que não está entre
 * os números vindos de tool = misatribuição (número de outra campanha). Retorna os telefones
 * suspeitos (só dígitos). `allowed` = telefones que apareceram nos resultados de tool do turno.
 */
export function checkPhoneAttribution(replyText: string, allowed: ReadonlySet<string>): string[] {
  return phoneTokensInText(replyText).filter((p) => !allowed.has(p));
}
