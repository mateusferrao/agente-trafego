import { createHash, randomBytes, randomInt } from "node:crypto";

/** Dígitos do código OTP de verificação de email. */
export const EMAIL_CODE_DIGITS = 6;
/** Bytes de entropia do token de reset de senha (link). */
export const RESET_TOKEN_BYTES = 32;

/** OTP numérico de 6 dígitos (zeros à esquerda). Só o hash de `email:code` persiste. */
export function generateEmailCode(): string {
  return String(randomInt(0, 10 ** EMAIL_CODE_DIGITS)).padStart(EMAIL_CODE_DIGITS, "0");
}

/** Token opaco do reset (vai no link; nunca persistido em claro). */
export function generateResetToken(): string {
  return randomBytes(RESET_TOKEN_BYTES).toString("base64url");
}

/** sha256(value) hex — o que persiste em `one_time_tokens.tokenHash`. */
export function hashOneTimeToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash do código-email = sha256(`email:code`) — o código sozinho não basta. */
export function hashEmailCode(email: string, code: string): string {
  return hashOneTimeToken(`${email}:${code}`);
}
