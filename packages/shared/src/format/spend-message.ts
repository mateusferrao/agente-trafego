/**
 * Formatação PURA da mensagem de gasto (Fatia 0). Sem IO — testável direto e
 * reusável pelo nó `notify` do grafo (fatia 3a). A casca só injeta os valores.
 */
export interface SpendMessageInput {
  readonly accountName: string;
  readonly currency: string;
  readonly spend: number;
  /** ex: "nos últimos 7 dias". */
  readonly windowLabel: string;
}

export function formatSpendMessage(input: SpendMessageInput): string {
  return `Conta ${input.accountName}: gastou ${input.currency} ${input.spend.toFixed(2)} ${input.windowLabel}.`;
}
