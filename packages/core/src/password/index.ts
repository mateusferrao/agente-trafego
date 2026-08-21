/**
 * Força de senha (regra pura). Retorna resultado tipado (código de motivo, não
 * cópia de UI — a casca mapeia p/ mensagem amigável §13). Regra: min 8 + ≥1 letra
 * + ≥1 número (baixo atrito, barra o óbvio; sem zxcvbn no MVP).
 */
export const PASSWORD_MIN_LENGTH = 8;

export type PasswordWeakReason = "too_short" | "no_letter" | "no_number";
export type PasswordCheck = { readonly ok: true } | { readonly ok: false; readonly reason: PasswordWeakReason };

export function checkPasswordStrength(password: string): PasswordCheck {
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (!/[a-zA-Z]/.test(password)) return { ok: false, reason: "no_letter" };
  if (!/[0-9]/.test(password)) return { ok: false, reason: "no_number" };
  return { ok: true };
}
