const BR_COUNTRY_CODE = "55";
const BR_DDD_LENGTH = 2;
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
