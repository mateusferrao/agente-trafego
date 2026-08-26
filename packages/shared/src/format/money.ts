/**
 * Formatação de dinheiro PURA e currency-aware (pivô B2B/B2C). Fonte única do
 * símbolo por moeda — usada na saída do agente (eco de escrita, money-shot,
 * config-echo, pulso, waste). Símbolo conhecido → "R$ 120,00"; desconhecido →
 * fallback ISO "JPY 120,00" (honesto, nunca inventa símbolo). Locale pt-BR nos
 * separadores (vírgula decimal), coerente com a voz do produto.
 */

/** Moeda default do sistema (ICP majoritário) — fonte única (sem string mágica). */
export const DEFAULT_CURRENCY = "BRL";

const SYMBOLS: Readonly<Record<string, string>> = {
  BRL: "R$",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Prefixo da moeda: símbolo conhecido, senão o código ISO (fallback honesto). */
export function currencySymbol(currency: string | null | undefined): string {
  const code = (currency ?? DEFAULT_CURRENCY).toUpperCase();
  return SYMBOLS[code] ?? code;
}

/**
 * Formata um valor com o prefixo da moeda e 2 casas (vírgula decimal pt-BR).
 * Ex: `formatMoney(120.5, "BRL")` → "R$ 120,50"; `(120.5, "JPY")` → "JPY 120,50".
 */
export function formatMoney(amount: number, currency: string | null | undefined): string {
  return `${currencySymbol(currency)} ${amount.toFixed(2).replace(".", ",")}`;
}
