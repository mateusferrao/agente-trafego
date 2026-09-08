// Teto de corpo do webhook da Evolution (fix do 413) — PURO, sem env (a fonte do MB fica na
// casca/routes). A Evolution embute a MÍDIA em base64 no corpo JSON (base64 ligado p/ áudio
// inline — docker/EASYPANEL.md), então vídeo/imagem/áudio estoura o default de 1 MB do Fastify
// → 413 antes do handler. Derivado do maior vídeo aceito × inflação base64 + folga de envelope.

const BYTES_PER_MB = 1024 * 1024;
// base64 codifica 3 bytes crus em 4 chars → o payload infla ~4/3.
const BASE64_INFLATION_NUM = 4;
const BASE64_INFLATION_DEN = 3;
// folga p/ o envelope JSON da Evolution (key, pushName, contextInfo, mimetype…) além da mídia.
const WEBHOOK_ENVELOPE_HEADROOM_MB = 4;

/** Bytes do `bodyLimit` por-rota do webhook, a partir do teto de vídeo do WhatsApp (em MB). */
export function webhookBodyLimitBytes(maxWhatsappVideoMb: number): number {
  const inflatedMb = (maxWhatsappVideoMb * BASE64_INFLATION_NUM) / BASE64_INFLATION_DEN + WEBHOOK_ENVELOPE_HEADROOM_MB;
  return Math.ceil(inflatedMb) * BYTES_PER_MB;
}
