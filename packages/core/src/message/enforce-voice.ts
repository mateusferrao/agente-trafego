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
 *  Exige pontuação de interjeição (evita cortar "Claro que dá..."). NÃO removemos aberturas
 *  CALOROSAS (beleza/opa/olha) — o kernel quer calor no cumprimento; só o tom de assistente. */
function stripAssistantOpeners(text: string): string {
  return text
    .replace(/^[ \t]*(?:claro|com certeza|perfeito|ótimo)[!,.][ \t]+/iu, "")
    .replace(/^[ \t]*aqui (?:está|vai)[:!,.]?[ \t]+/iu, "");
}

/** Span em *negrito* do dialeto WhatsApp (nome de campanha/conjunto). Capturado no split
 *  p/ ser PRESERVADO — o travessão dentro dele é separador legítimo, não cara de IA. */
const BOLD_SPAN = /(\*[^*\n]+\*)/g;
/** Linha de LISTA (opção numerada/bullet) — o travessão "Nome — categoria" é dos nossos ecos. */
const LIST_LINE = /^\s*(?:•|\d+[.)])\s/u;

/**
 * Travessão dramático (—, em-dash U+2014) como conector em PROSA vira vírgula — o tic de IA
 * que o kernel já proíbe, policiado no runtime (V1, rede leve). CONSERVADOR:
 * - só o em-dash COM espaços dos dois lados (" — "); colado ("bem—assim") e hífen ("-") ficam;
 * - NÃO toca no en-dash (–, U+2013) de FAIXA de valor ("R$ 100 – R$ 200");
 * - PRESERVA linhas de LISTA e conteúdo em *negrito* (separadores legítimos dos ecos). Idempotente.
 */
function stripDramaticEmDash(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (LIST_LINE.test(line)) return line;
      // split com grupo de captura → segmentos alternam não-negrito / *negrito*; troca o
      // travessão-conector só nos segmentos de prosa (fora do negrito).
      return line
        .split(BOLD_SPAN)
        .map((seg) => (seg.startsWith("*") && seg.endsWith("*") ? seg : seg.replace(/ — /g, ", ")))
        .join("");
    })
    .join("\n");
}

/** Sentence case: capitaliza a 1ª LETRA quando a mensagem começa minúscula. Guarda:
 *  não toca em início por R$/dígito/emoji/símbolo (só letra minúscula latina). */
function capitalizeFirst(text: string): string {
  return text.replace(/^([ \t]*)([a-zà-ÿ])/u, (_m, ws: string, ch: string) => ws + ch.toLocaleUpperCase("pt-BR"));
}

/**
 * Aplica o policiamento de voz. Ordem: remove abertura de assistente → higieniza o travessão
 * dramático → quebra bullets inline → capitaliza a 1ª letra (depois das remoções, pega a nova
 * primeira palavra). Idempotente (aplicar 2× = 1×).
 */
export function enforceVoice(text: string): string {
  return capitalizeFirst(breakInlineBullets(stripDramaticEmDash(stripAssistantOpeners(text))));
}
