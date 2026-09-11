// Baixa os bytes de uma URL de mídia (fbcdn/CDN) e devolve como data URL base64 inline — pra a
// visão mandar os BYTES ao provider em vez da URL crua. A URL assinada do fbcdn rotaciona e
// expira; quando o provider LLM a busca server-side (tarde), volta 410 Gone → a análise falhava.
// Baixando nós mesmos, logo antes de montar a mensagem, encurtamos a janela e mandamos inline.
// Reusa a rede de segurança da miniatura de rascunho (drafts/service.ts:fetchThumbImage): teto de
// tempo, só content-type de imagem, cap de bytes. Falha/timeout/violação → null (o chamador
// degrada aquele frame). NUNCA lança. Fora do MetaGovernor (é fbcdn/CDN, não a Graph API).

const DOWNLOAD_TIMEOUT_MS = 8000;
const DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;

export async function downloadAsDataUrl(url: string): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch(() => null);
  if (!res || !res.ok) return null;
  // só o mediatype (sem parâmetros tipo "; charset=binary") — espaço no data: URL o invalidaria.
  const mediaType = ((res.headers.get("content-type") ?? "image/jpeg").split(";")[0] ?? "").trim();
  if (!mediaType.startsWith("image/")) return null; // não ecoa content-type arbitrário inline
  if (Number(res.headers.get("content-length") ?? 0) > DOWNLOAD_MAX_BYTES) return null;
  const buf = await res.arrayBuffer().catch(() => null);
  if (!buf) return null;
  const bytes = new Uint8Array(buf);
  // sem content-length (fbcdn às vezes streama), o teto só barra APÓS materializar — aceito, igual
  // ao fetch de miniatura; frames HD são pequenos e o content-length acima corta o caso comum.
  if (bytes.byteLength > DOWNLOAD_MAX_BYTES) return null;
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}
