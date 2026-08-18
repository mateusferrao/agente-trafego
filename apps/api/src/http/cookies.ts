import type { CookieSerializeOptions } from "@fastify/cookie";
import { SESSION_TTL_MS } from "../modules/auth/session-token.js";

/** Cookie com o token opaco de sessão (fonte da verdade, casado com o DB). */
export const SESSION_TOKEN_COOKIE = "trafego_session";

/** maxAge do cookie (segundos) — alinhado ao TTL da sessão server-side. */
export const SESSION_COOKIE_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

/**
 * Opções padrão do cookie de sessão: `httpOnly` (JS não lê), `sameSite=lax`
 * (mitiga CSRF em navegação), `secure` em produção, escopo raiz. Mesmas opções
 * para setar e limpar — senão o browser não casa o cookie a remover.
 */
export function sessionCookieOptions(isProd: boolean): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_S,
  };
}
