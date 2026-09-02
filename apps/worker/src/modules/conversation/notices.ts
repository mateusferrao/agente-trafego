// Avisos de cortesia ao contato (tom neutro, sentence case — §13/DESIGN.md).
// Enviados throttled (1 por conversa por janela) quando o áudio falha/vem vazio ou
// chega mídia que ainda não sabemos ler. Nunca deixam o usuário no escuro.

/** Rótulos PT (neutros, sem artigo) dos tipos de mídia não-suportada. */
const MEDIA_TYPE_LABELS_PT: Readonly<Record<string, string>> = {
  image: "imagem",
  video: "vídeo",
  document: "documento",
  sticker: "figurinha",
  contact: "contato",
  location: "localização",
};
const MEDIA_TYPE_FALLBACK_PT = "esse tipo de arquivo";

/** Áudio recebido mas a transcrição falhou (rede/provider/formato). */
export const AUDIO_FAILED_NOTICE =
  "Recebi seu áudio, mas não consegui ouvir agora. Pode escrever ou reenviar?";

/** Áudio recebido mas sem fala reconhecível (transcript vazio). */
export const AUDIO_EMPTY_NOTICE =
  "Recebi seu áudio, mas não consegui ouvir nada. Pode reenviar ou escrever?";

// ── Áudio CITADO (reply a um áudio marcando o bot): a transcrição do citado entra no
//    próprio turno (não é aviso avulso) — copy centralizada aqui junto das irmãs (§13). ──

/** Rótulo do autor citado quando não identificável pelo telefone. */
export const QUOTED_AUTHOR_FALLBACK_LABEL = "alguém";

/** Prefixo que injeta a transcrição do áudio citado no turno, antes do texto do usuário. */
export function quotedAudioPrefix(authorLabel: string, transcript: string): string {
  return `[Em resposta ao áudio de ${authorLabel}: ${transcript}]`;
}

/** Prefixo que injeta o TEXTO da mensagem citada no turno (reply de texto, S7) — para o
 *  agente considerar a mensagem respondida em vez de responder genérico. */
export function quotedTextPrefix(authorLabel: string, snippet: string): string {
  return `[Em resposta à mensagem de ${authorLabel}: "${snippet}"]`;
}

/** Nota no turno quando o áudio citado não pôde ser ouvido (falha de transcrição). */
export const QUOTED_AUDIO_UNHEARD_NOTE = "[não consegui ouvir o áudio que você respondeu]";

/** Nota no turno quando o áudio citado veio sem fala audível (transcript vazio). */
export const QUOTED_AUDIO_EMPTY_NOTE = "[o áudio que você respondeu veio sem fala audível]";

/** Aviso p/ mídia reconhecida mas ainda não suportada (imagem/vídeo/doc/figurinha). */
export function unsupportedMediaNotice(mediaType: string): string {
  const label = MEDIA_TYPE_LABELS_PT[mediaType] ?? MEDIA_TYPE_FALLBACK_PT;
  return `Por aqui eu ainda só entendo texto e áudio — ${label} eu ainda não consigo ler. Me manda por texto ou áudio?`;
}
