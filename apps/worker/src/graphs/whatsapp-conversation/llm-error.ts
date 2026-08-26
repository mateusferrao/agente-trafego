// Retrato diagnóstico de um erro do LLM do chat (Grafo B). O chat usa o ChatOpenAI do
// @langchain/openai direto (não a nossa LLMProviderPort), então os erros vêm crus em
// dois formatos: (1) APIError do SDK OpenAI (status + corpo do provider) OU (2) TypeError
// de PARSE lançado dentro do @langchain/openai quando a resposta vem com shape inesperado
// (ex.: `choices` vazio/sem `message` — o caso que jogou o gemini-3.7-flash no fallback).
// `String(err)` engolia tudo (só a mensagem); aqui extraímos name/message/stack + status/
// corpo cru do OpenRouter quando houver — sem vazar segredo (o token vai no header da
// REQUEST, nunca no corpo da RESPONSE).

const STACK_MAX_FRAMES = 8;
const BODY_MAX_CHARS = 1200;

/** Erro do SDK OpenAI/LangChain com os campos diagnósticos que podem existir. */
interface LlmLikeError extends Error {
  status?: number;
  code?: string | null;
  type?: string;
  lc_error_code?: string;
  response?: { status?: number; data?: unknown };
  error?: unknown; // APIError.error = corpo de erro do provider
}

/** Serializa o corpo do provider com teto de tamanho (não estoura o log). */
function truncate(value: unknown): unknown {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[não-serializável]";
  }
  if (text.length <= BODY_MAX_CHARS) return value;
  return `${text.slice(0, BODY_MAX_CHARS)}… (+${text.length - BODY_MAX_CHARS} chars)`;
}

/**
 * Extrai um objeto de log seguro e diagnóstico de qualquer erro do LLM. Sempre inclui
 * `name`/`message`; adiciona `stack` (primeiros frames — aponta ONDE no @langchain/openai
 * quebrou), e `status`/`httpStatus`/`code`/`type`/`lcCode`/`body` quando presentes.
 */
export function describeLlmError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { raw: String(err) };
  const e = err as LlmLikeError;
  const body = e.response?.data ?? e.error;
  return {
    name: e.name,
    message: e.message,
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(typeof e.response?.status === "number" ? { httpStatus: e.response.status } : {}),
    ...(e.code ? { code: e.code } : {}),
    ...(e.type ? { type: e.type } : {}),
    ...(e.lc_error_code ? { lcCode: e.lc_error_code } : {}),
    ...(body !== undefined ? { body: truncate(body) } : {}),
    stack: (e.stack ?? "").split("\n").slice(0, STACK_MAX_FRAMES).join("\n"),
  };
}
