// Sanitização determinística do texto de saída p/ o WhatsApp. PURA e idempotente.
// A fluidez NÃO pode depender do modelo obedecer o prompt: mesmo que o LLM emita
// markdown padrão (`**negrito**`, `# título`, `[texto](url)`), esta camada normaliza
// para o dialeto do WhatsApp (`*negrito*`, `_itálico_`, `~tachado~`) antes do envio.
// Conservadora: não toca em `_itálico_`, em `*` já isolado, nem em ``` monospace.

/** Colapsa 2+ asteriscos (`**bold**`, `***x***`) em um só (negrito WhatsApp). */
function normalizeBold(text: string): string {
  return text.replace(/\*\*+/g, "*");
}

/** Colapsa 2+ tis (`~~strike~~`) em um (tachado WhatsApp = `~x~`). */
function normalizeStrike(text: string): string {
  return text.replace(/~~+/g, "~");
}

/** Link markdown `[texto](url)` → `texto (url)` (WhatsApp não renderiza o link). */
function flattenLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

/** Remove o prefixo de título markdown (`# `, `## `, …) no início de cada linha. */
function stripHeadings(text: string): string {
  return text.replace(/^#{1,6}[ \t]+/gm, "");
}

/**
 * Bullet markdown ESTRITO (`- ` / `* ` no início da linha, seguido de espaço) → `• `.
 * A exigência do espaço protege hífen no meio/começo de valor ("- R$ 50") e o
 * negrito de linha (`*negrito*`, sem espaço após o `*`).
 */
function normalizeBullets(text: string): string {
  return text.replace(/^[ \t]*[-*][ \t]+/gm, "• ");
}

/**
 * Remove RÉGUA HORIZONTAL markdown (linha só com `---` / `***` / `___`, 3+ chars,
 * opcionalmente espaçada) — o WhatsApp não renderiza HR, então cairia como `---`
 * literal (robótico, "zero fluido"). Roda ANTES do normalizeBold (senão `***`
 * viraria `*`). Preserva a quebra de parágrafo em volta (collapseBlankLines cuida
 * do espaçamento). Não toca em `***bold***`/`--valor` (exige a linha INTEIRA ser régua).
 */
function stripHorizontalRules(text: string): string {
  return text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$\n?/gm, "");
}

/** Colapsa 3+ quebras de linha em uma linha em branco (evita buracos no chat). */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Normaliza o texto para o dialeto do WhatsApp. Idempotente (aplicar 2× = 1×).
 * Ordem: régua horizontal → inline (negrito/tachado/link) → linha (título/bullet) → espaçamento.
 */
export function sanitizeWhatsappText(text: string): string {
  const noRules = stripHorizontalRules(text);
  const inline = flattenLinks(normalizeStrike(normalizeBold(noRules)));
  const lineLevel = normalizeBullets(stripHeadings(inline));
  return collapseBlankLines(lineLevel).trim();
}
