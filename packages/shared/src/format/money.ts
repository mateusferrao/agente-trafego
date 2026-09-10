/**
 * Formatação de dinheiro PURA e currency-aware (pivô B2B/B2C). Fonte única do
 * símbolo E do expoente por moeda — usada na saída do agente (eco de escrita,
 * money-shot, config-echo, pulso, waste) e na conversão unidade-menor↔maior que
 * a Meta exige. Símbolo conhecido → "R$ 120,00"; desconhecido → fallback ISO
 * "JPY 120" (honesto, nunca inventa símbolo). Locale pt-BR nos separadores
 * (vírgula decimal), coerente com a voz do produto.
 *
 * A Meta reporta/aceita budget em UNIDADE MENOR (centavos p/ moedas de 2 casas,
 * mas ienes p/ JPY de 0 casas, fils p/ BHD de 3 casas). Converter com `×100`
 * fixo corrompe silenciosamente as moedas de 0/3 casas — por isso a conversão
 * passa SEMPRE pela moeda (`minorUnitDivisor`), nunca por um número mágico.
 */

/** Moeda default do sistema (ICP majoritário) — fonte única (sem string mágica). */
export const DEFAULT_CURRENCY = "BRL";

const SYMBOLS: Readonly<Record<string, string>> = {
  BRL: "R$",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/**
 * Expoente da unidade menor por moeda (ISO-4217). Só as moedas que FOGEM do
 * default de 2 casas — as demais caem no default. Mapa estático (sem chamar a
 * plataforma): fonte única do "quantas casas essa moeda tem".
 */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  // sem sub-unidade (a unidade menor É a unidade maior)
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // três casas (milésimos)
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};
const DEFAULT_EXPONENT = 2;

/** Prefixo da moeda: símbolo conhecido, senão o código ISO (fallback honesto). */
export function currencySymbol(currency: string | null | undefined): string {
  const code = (currency ?? DEFAULT_CURRENCY).toUpperCase();
  return SYMBOLS[code] ?? code;
}

/** Nº de casas decimais da moeda (default 2). Fonte única do expoente. */
export function currencyExponent(currency: string | null | undefined): number {
  const code = (currency ?? DEFAULT_CURRENCY).toUpperCase();
  return CURRENCY_EXPONENT[code] ?? DEFAULT_EXPONENT;
}

/** Divisor unidade-menor→maior da moeda (`10^expoente`). BRL=100; JPY=1; BHD=1000. */
export function minorUnitDivisor(currency: string | null | undefined): number {
  return 10 ** currencyExponent(currency);
}

/** Unidade MAIOR (reais/dólares/ienes) → unidade menor que a Meta aceita. */
export function toMinorUnits(major: number, currency: string | null | undefined): number {
  return Math.round(major * minorUnitDivisor(currency));
}

/** Unidade menor → maior, na moeda certa (sem arredondar — o formato decide as casas). */
export function minorToMajor(minor: number, currency: string | null | undefined): number {
  return minor / minorUnitDivisor(currency);
}

/**
 * Formata um valor (unidade MAIOR) com o prefixo da moeda e as casas da moeda
 * (vírgula decimal pt-BR). Ex: `formatMoney(120.5, "BRL")` → "R$ 120,50";
 * `(120.5, "JPY")` → "JPY 121" (JPY não tem casas decimais).
 */
export function formatMoney(amount: number, currency: string | null | undefined): string {
  return `${currencySymbol(currency)} ${amount.toFixed(currencyExponent(currency)).replace(".", ",")}`;
}

/**
 * Igual a `formatMoney`, mas recebe a unidade MENOR (o que a Meta reporta) e
 * converte pela moeda antes de exibir — a fonte única que substitui o `minor/100`
 * mágico espalhado (que quebrava JPY/BHD).
 */
export function formatMoneyMinor(minor: number, currency: string | null | undefined): string {
  const n = Number(minor);
  return formatMoney(Number.isFinite(n) ? minorToMajor(n, currency) : 0, currency);
}
