// Gate de endereçamento no grupo (puro, sem IO): a mensagem "dirige" o bot quando o
// telefone da instância aparece nas menções (@) OU é o autor da mensagem citada
// (reply). Sem essas duas condições, o grupo conversa livremente sem acionar o
// agente (§9 — o agente não fica "escutando" o grupo o tempo todo).

/** Subconjunto de InboundGroupContext relevante ao gate (evita import cruzado da porta). */
export interface AddressingSignal {
  readonly mentionedPhones: readonly string[];
  readonly quotedAuthorPhone: string | null;
}

/** `botPhone` ausente (instância sem número resolvido ainda) → nunca dirigido. */
export function isAddressedToBot(signal: AddressingSignal, botPhone: string | null): boolean {
  if (!botPhone) return false;
  return signal.mentionedPhones.includes(botPhone) || signal.quotedAuthorPhone === botPhone;
}
