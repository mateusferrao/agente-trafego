/**
 * Ritmo humano do envio: quanto tempo mostrar "digitando…" antes de um balão,
 * proporcional ao seu tamanho (balão maior = pausa maior), com piso e teto. Puro.
 * NÃO simula digitação real (seria lento demais) — dá só o "toque" de conversa.
 */

/** Ms de "digitando" por caractere do balão. */
export const TYPING_MS_PER_CHAR = 18;
/** Piso: até um "ok" mostra um instante de "digitando". */
export const TYPING_MIN_MS = 400;
/** Teto: nunca deixa o usuário esperando demais por um balão. */
export const TYPING_MAX_MS = 3500;

/** Dica de "digitando…" (ms) proporcional ao tamanho do balão, entre piso e teto. */
export function computeTypingHint(part: string): number {
  const raw = part.length * TYPING_MS_PER_CHAR;
  return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, raw));
}
