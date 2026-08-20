// Janela de contexto do chat (5b-2): manda ao LLM só os últimos N TURNOS + teto de
// tokens, SEM nunca quebrar o par tool_call/tool_result (senão a API do LLM rejeita).
// Turno = uma fala do usuário (HumanMessage) + toda a resposta (AI/Tool) até a próxima
// fala. Puro/testável. O system prompt é reinjetado à parte (fora da janela).

import type { BaseMessage } from "@langchain/core/messages";

/** Aproximação de tokens por conteúdo (≈4 chars/token) — 2ª rede sobre turnos "gordos". */
const CHARS_PER_TOKEN = 4;

function role(m: BaseMessage): string {
  return typeof m._getType === "function" ? m._getType() : "";
}

function contentLength(m: BaseMessage): number {
  const c = m.content;
  return typeof c === "string" ? c.length : JSON.stringify(c ?? "").length;
}

/** Agrupa mensagens em turnos: cada turno começa numa HumanMessage. O que vem antes
 *  da 1ª fala (raro) fica num grupo inicial próprio. */
function groupIntoTurns(messages: readonly BaseMessage[]): BaseMessage[][] {
  const turns: BaseMessage[][] = [];
  for (const m of messages) {
    if (role(m) === "human" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

export interface WindowOptions {
  readonly maxTurns: number;
  readonly maxTokens: number;
}

/**
 * Recorta o histórico aos últimos `maxTurns` turnos e, se ainda estourar `maxTokens`,
 * derruba os turnos mais antigos (mantém ao menos o último turno inteiro).
 */
export function windowMessages(
  messages: readonly BaseMessage[],
  { maxTurns, maxTokens }: WindowOptions,
): BaseMessage[] {
  const turns = groupIntoTurns(messages);
  let kept = turns.slice(-maxTurns);

  const tokensOf = (ts: BaseMessage[][]): number =>
    Math.ceil(ts.flat().reduce((sum, m) => sum + contentLength(m), 0) / CHARS_PER_TOKEN);

  while (kept.length > 1 && tokensOf(kept) > maxTokens) kept = kept.slice(1);

  return kept.flat();
}
