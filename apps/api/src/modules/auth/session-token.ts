import { createHash, randomBytes } from "node:crypto";

/** Bytes de entropia do token opaco de sessão (256 bits). */
export const SESSION_TOKEN_BYTES = 32;

/** Time-to-live da sessão. Renovado de forma deslizante enquanto em uso. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

/**
 * Throttle do slide: só reescreve `expiresAt`/`lastUsedAt` se o último uso foi
 * há mais que isto. Evita um UPDATE por request autenticado (inclusive GETs),
 * mantendo o efeito de expiração deslizante.
 */
export const SESSION_SLIDE_THROTTLE_MS = 1000 * 60 * 5; // 5 min

/**
 * Gera o token opaco que vai no cookie (nunca persistido em claro). O DB guarda
 * apenas o `hashSessionToken` dele.
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/** sha256(token) em hex — o que é gravado/consultado em `sessions.tokenHash`. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Expiração absoluta a partir de um instante base (injetado p/ testabilidade). */
export function computeSessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}
