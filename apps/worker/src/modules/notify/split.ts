/**
 * Quebra de mensagem outbound do WhatsApp: cada bloco separado por 2+ quebras de
 * linha vira uma mensagem própria (evita parede de texto no chat). Puro/testável.
 * Só o chat quebra; o push do cron envia inteiro (ban-safety §9 — menos volume).
 */

/** Teto de partes: acima disso, o excedente é juntado no último bloco. */
export const WHATSAPP_SPLIT_MAX_PARTS = 5;
/** Atraso entre partes no envio (ordem + toque natural). */
export const WHATSAPP_PART_DELAY_MS = 800;

/** Divide o texto em mensagens (blocos por `\n\n`), respeitando o cap de partes. */
export function splitMessage(text: string, maxParts = WHATSAPP_SPLIT_MAX_PARTS): string[] {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  if (blocks.length <= maxParts) return blocks;
  // excedente juntado no último bloco (mantém o cap sem perder conteúdo).
  const head = blocks.slice(0, maxParts - 1);
  const tail = blocks.slice(maxParts - 1).join("\n\n");
  return [...head, tail];
}
