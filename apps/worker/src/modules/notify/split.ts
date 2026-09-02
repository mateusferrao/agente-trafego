/**
 * Quebra de mensagem outbound do WhatsApp. Puro/testável. Cascata de fronteiras
 * NATURAIS (nunca corta palavra/frase): parágrafo (`\n\n`) → linha (`\n`) → frase.
 * O alvo em chars é só o GATILHO da subdivisão, jamais o ponto de corte; um bloco
 * abaixo do alvo passa intacto. Só o chat quebra; o push do cron envia inteiro
 * (ban-safety §9 — menos volume).
 */

/** Teto de partes: acima disso, o excedente é juntado no último bloco. */
export const WHATSAPP_SPLIT_MAX_PARTS = 5;
/** Alvo de tamanho por balão: acima disso o bloco é subdividido por fronteira natural. */
export const WHATSAPP_SOFT_MAX_CHARS = 600;

/**
 * Junta parágrafos numa mensagem cujos balões o `splitMessage` separa (fronteira `\n\n`).
 * Fonte única do contrato de "balão" para os ecos (eco+confirma) — usar isto em vez de
 * `.join("\n")` (que vira UM balão) ou `.join("\n\n")` solto. Descarta vazios (linhas
 * opcionais condicionais) e faz trim de cada um.
 */
export function joinBalloons(paragraphs: readonly string[]): string {
  return paragraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("\n\n");
}

/** Empacota unidades (linhas/frases) em partes, juntando por `sep` até o alvo. */
function packUnits(units: readonly string[], sep: string, softMax: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur.length === 0) {
      cur = u;
      continue;
    }
    const candidate = `${cur}${sep}${u}`;
    if (candidate.length > softMax) {
      parts.push(cur);
      cur = u;
    } else {
      cur = candidate;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/** Divide um trecho por FRASE (fim de `.`/`!`/`?` + espaço). Frase única > alvo fica inteira. */
function splitBySentence(text: string, softMax: number): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length <= 1) return [text]; // uma frase gigante: não parte o sentido
  return packUnits(sentences, " ", softMax);
}

/** Subdivide UM bloco acima do alvo: por linha (`\n`) e, se a linha ainda passar, por frase. */
function splitParagraph(paragraph: string, softMax: number): string[] {
  if (paragraph.length <= softMax) return [paragraph];
  const lines = paragraph
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length > 1) {
    const units = lines.flatMap((l) => (l.length > softMax ? splitBySentence(l, softMax) : [l]));
    return packUnits(units, "\n", softMax);
  }
  return splitBySentence(paragraph, softMax);
}

/**
 * Divide o texto em mensagens: blocos por `\n\n`, cada bloco acima do alvo subdividido
 * por fronteira natural, respeitando o cap de partes (excedente juntado no último).
 */
export function splitMessage(text: string, maxParts = WHATSAPP_SPLIT_MAX_PARTS): string[] {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const expanded = blocks.flatMap((b) => splitParagraph(b, WHATSAPP_SOFT_MAX_CHARS));
  if (expanded.length <= maxParts) return expanded;
  // Acima do cap: empacota parágrafos curtos vizinhos até o alvo ANTES de aplicar o
  // corte — sem isso, um texto com vários parágrafos curtos (título, cabeçalhos de
  // seção) vira 1 balão por parágrafo até o 4º, e TUDO que sobra (o resto do relatório
  // inteiro) cai cru, sem repacotar, no último balão (achado real: WhatsApp).
  const packed = packUnits(expanded, "\n\n", WHATSAPP_SOFT_MAX_CHARS);
  if (packed.length <= maxParts) return packed;
  // ainda acima do cap mesmo empacotado: excedente juntado no último bloco (mantém o
  // cap sem perder conteúdo).
  const head = packed.slice(0, maxParts - 1);
  const tail = packed.slice(maxParts - 1).join("\n\n");
  return [...head, tail];
}
