// Policiamento de VOZ do texto de saída p/ o WhatsApp — PURO e idempotente. Interesse
// SEPARADO do `sanitizeWhatsappText` (que é só dialeto-markdown): aqui conserta o que o
// LLM escorrega na VOZ, de forma CONSERVADORA (nunca reescreve prosa nem toca em número).
// Composto DEPOIS do sanitize no `sendToConversation` (ponto único de todo outbound).

/**
 * Sugestões emitidas inline ("...diagnóstico. - item. - item") viram bullets em linha
 * própria — o bug de parede de texto. CONSERVADOR: só quebra um " - " precedido por
 * FIM DE FRASE (. ! ? :) e seguido de MAIÚSCULA (item tipo-cláusula). Assim preserva
 * nome de campanha ("TESTE - Melhores"), faixa de valor ("R$ 100 - R$ 200") e valor
 * negativo ("-R$ 50"). Emite "• " direto (roda depois do sanitize).
 */
function breakInlineBullets(text: string): string {
  return text.replace(/([.!?:])[ \t]+-[ \t]+(?=[A-ZÀ-Ú])/gu, "$1\n• ");
}

/** Aberturas de assistente no início ("Claro!", "Com certeza,", "Aqui está") — removidas.
 *  Exige pontuação de interjeição (evita cortar "Claro que dá..."). */
function stripAssistantOpeners(text: string): string {
  return text
    .replace(/^[ \t]*(?:claro|com certeza|perfeito|ótimo)[!,.][ \t]+/iu, "")
    .replace(/^[ \t]*aqui (?:está|vai)[:!,.]?[ \t]+/iu, "");
}

/** Sentence case: capitaliza a 1ª LETRA quando a mensagem começa minúscula. Guarda:
 *  não toca em início por R$/dígito/emoji/símbolo (só letra minúscula latina). */
function capitalizeFirst(text: string): string {
  return text.replace(/^([ \t]*)([a-zà-ÿ])/u, (_m, ws: string, ch: string) => ws + ch.toLocaleUpperCase("pt-BR"));
}

/**
 * Aplica o policiamento de voz. Ordem: remove abertura de assistente → quebra bullets
 * inline → capitaliza a 1ª letra (depois da remoção, pega a nova primeira palavra).
 * Idempotente (aplicar 2× = 1×).
 */
export function enforceVoice(text: string): string {
  return capitalizeFirst(breakInlineBullets(stripAssistantOpeners(text)));
}
