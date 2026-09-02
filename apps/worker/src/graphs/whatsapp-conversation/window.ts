// Janela de contexto do chat (5b-2): manda ao LLM só os últimos N TURNOS + teto de
// tokens, SEM nunca quebrar o par tool_call/tool_result (senão a API do LLM rejeita).
// Turno = uma fala do usuário (HumanMessage) + toda a resposta (AI/Tool) até a próxima
// fala. Puro/testável. O system prompt é reinjetado à parte (fora da janela).

import { AIMessage, type BaseMessage } from "@langchain/core/messages";

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

/**
 * Sanitiza o par tool_call/tool_result antes de mandar ao LLM. A API (OpenAI/Azure) REJEITA
 * (400 "No tool output found for function call …") qualquer `tool_call` do assistant sem o
 * `ToolMessage` correspondente — e o checkpointer pode ter gravado um órfão se um turno anterior
 * QUEBROU entre o `AI(tool_calls)` (já persistido) e as respostas das tools (nunca persistidas).
 * Sem esta limpeza, o thread fica ENVENENADO: todo turno seguinte reenvia o órfão → 400 → fallback.
 *
 * Regra: mantém só os `tool_calls` que têm resposta; tira do assistant os órfãos (e descarta a
 * mensagem se sobrar vazia); descarta `ToolMessage` sem `tool_call` sobrevivente. Puro/testável.
 */
export function sanitizeToolPairs(messages: readonly BaseMessage[]): BaseMessage[] {
  const answeredIds = new Set<string>();
  for (const m of messages) {
    if (role(m) === "tool") {
      const id = (m as { tool_call_id?: string }).tool_call_id;
      if (id) answeredIds.add(id);
    }
  }
  const survivingCallIds = new Set<string>();
  const out: BaseMessage[] = [];
  for (const m of messages) {
    const calls = role(m) === "ai" ? ((m as AIMessage).tool_calls ?? []) : [];
    if (calls.length === 0) {
      out.push(m);
      continue;
    }
    const kept = calls.filter((tc) => tc.id && answeredIds.has(tc.id));
    if (kept.length === calls.length) {
      for (const tc of kept) survivingCallIds.add(tc.id!);
      out.push(m);
      continue;
    }
    // sobraram órfãos → reconstrói sem eles (ou descarta se ficar vazio: sem texto e sem call).
    const c = (m as AIMessage).content;
    const hasText = typeof c === "string" ? c.trim().length > 0 : Array.isArray(c) ? c.length > 0 : Boolean(c);
    if (kept.length === 0 && !hasText) continue;
    for (const tc of kept) survivingCallIds.add(tc.id!);
    out.push(new AIMessage({ content: c, tool_calls: kept }));
  }
  // remove resultados órfãos (ToolMessage sem tool_call sobrevivente).
  return out.filter((m) => {
    if (role(m) !== "tool") return true;
    const id = (m as { tool_call_id?: string }).tool_call_id;
    return Boolean(id && survivingCallIds.has(id));
  });
}
