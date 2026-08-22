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
  "recebi seu áudio, mas não consegui ouvir agora. Pode escrever ou reenviar?";

/** Áudio recebido mas sem fala reconhecível (transcript vazio). */
export const AUDIO_EMPTY_NOTICE =
  "recebi seu áudio, mas não consegui ouvir nada. Pode reenviar ou escrever?";

/** Aviso p/ mídia reconhecida mas ainda não suportada (imagem/vídeo/doc/figurinha). */
export function unsupportedMediaNotice(mediaType: string): string {
  const label = MEDIA_TYPE_LABELS_PT[mediaType] ?? MEDIA_TYPE_FALLBACK_PT;
  return `por aqui eu ainda só entendo texto e áudio — ${label} eu ainda não consigo ler. Me manda por texto ou áudio?`;
}
