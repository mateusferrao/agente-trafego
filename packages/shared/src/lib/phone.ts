const BR_COUNTRY_CODE = "55";
const BR_DDD_LENGTH = 2;

/**
 * Mínimo de dígitos p/ uma sequência ser um telefone PLAUSÍVEL (Fatia 7). Calibrado p/
 * aceitar o subscriber BR (`95349-1166` = 9) e rejeitar tokens curtos/identificadores
 * (`1398` = 4, `TOP 6` = 1) — a raiz do bug de misatribuição. Não é dialabilidade, é
 * "isto parece um telefone?" (honestidade: o nome pede confirmação de qualquer jeito).
 */
const MIN_PLAUSIBLE_PHONE_DIGITS = 8;
/** Teto E.164 — acima disso é id/ruído, não telefone. */
const MAX_PLAUSIBLE_PHONE_DIGITS = 15;

/** Hosts de deep-link de WhatsApp (público, não é vocabulário Meta). */
const WHATSAPP_URL_HOSTS = ["wa.me", "api.whatsapp.com", "whatsapp.com"] as const;

/** Só os dígitos de uma string (descarta `+`, separadores, texto). */
function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}

/** A sequência de dígitos é um telefone plausível (contagem dentro da faixa)? */
function isPlausiblePhone(digits: string): boolean {
  return digits.length >= MIN_PLAUSIBLE_PHONE_DIGITS && digits.length <= MAX_PLAUSIBLE_PHONE_DIGITS;
}

/**
 * Extrai o telefone (só dígitos, E.164 sem "+") de um deep-link de WhatsApp — `wa.me/<n>`
 * ou `api.whatsapp.com/send?phone=<n>`. URL não-WhatsApp, inválida, ou sem telefone
 * plausível → `null`. Pura. Formato de deep-link é público (não Meta) — por isso vive
 * aqui e não no adapter.
 */
export function extractPhoneFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!WHATSAPP_URL_HOSTS.includes(host as (typeof WHATSAPP_URL_HOSTS)[number])) return null;
  const fromQuery = parsed.searchParams.get("phone");
  const candidate = digitsOnly(fromQuery ?? parsed.pathname);
  return isPlausiblePhone(candidate) ? candidate : null;
}

/** Token que PODE ser um telefone: começa/termina em dígito, com separadores no meio. */
const PHONE_TOKEN_RE = /[+(]?\d[\d\s().+-]*\d/g;

/**
 * Extrai um telefone COMPLETO (só dígitos) codificado no nome de uma entidade — convenção
 * do cliente (ex: `… WHATS 95349-1166 …`). Varre tokens telefônicos e devolve o MAIOR que
 * cabe na faixa plausível; token curto (`1398`, `TOP 6`) → `null`. Pura. O chamador SEMPRE
 * rotula a origem como `campaign_name` e pede confirmação (o nome não é autoritativo).
 */
export function extractPhoneFromName(name: string): string | null {
  const matches = name.match(PHONE_TOKEN_RE) ?? [];
  let best: string | null = null;
  for (const token of matches) {
    const digits = digitsOnly(token);
    if (isPlausiblePhone(digits) && (best === null || digits.length > best.length)) best = digits;
  }
  return best;
}
/** Celular BR = DDD + 9 dígitos (nono dígito obrigatório desde 2016). */
const BR_MOBILE_LOCAL_LENGTH = 9;
/** Forma legada/quirk (ex: WhatsApp em `addressingMode: "lid"` às vezes omite o 9º dígito). */
const BR_MOBILE_LOCAL_LENGTH_LEGACY = 8;

/**
 * Variantes plausíveis de um telefone BR (`+55...`) alternando o 9º dígito do
 * celular — o WhatsApp nem sempre entrega o mesmo formato (quirk conhecido do
 * `addressingMode: "lid"`, ver `resolveInboundContact`). Não-BR ou fora do
 * padrão de celular → devolve só o valor original (sem variante). Pura.
 */
export function brPhoneVariants(e164: string): readonly string[] {
  const digits = e164.startsWith("+") ? e164.slice(1) : e164;
  if (!digits.startsWith(BR_COUNTRY_CODE)) return [e164];

  const local = digits.slice(BR_COUNTRY_CODE.length);
  const ddd = local.slice(0, BR_DDD_LENGTH);
  const subscriber = local.slice(BR_DDD_LENGTH);

  if (subscriber.length === BR_MOBILE_LOCAL_LENGTH && subscriber.startsWith("9")) {
    return [e164, `+${BR_COUNTRY_CODE}${ddd}${subscriber.slice(1)}`];
  }
  if (subscriber.length === BR_MOBILE_LOCAL_LENGTH_LEGACY) {
    return [e164, `+${BR_COUNTRY_CODE}${ddd}9${subscriber}`];
  }
  return [e164];
}
