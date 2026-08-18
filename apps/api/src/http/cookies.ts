import type { CookieSerializeOptions } from "@fastify/cookie";
import { sealData, unsealData } from "iron-session";
import { SESSION_TTL_MS } from "../modules/auth/session-token.js";

/** Cookie com o token opaco de sessão (fonte da verdade, casado com o DB). */
export const SESSION_TOKEN_COOKIE = "trafego_session";
/** Cookie selado (iron-session) com o contexto mutável da sessão (org ativa). */
export const SESSION_CONTEXT_COOKIE = "trafego_ctx";

/** maxAge do cookie (segundos) — alinhado ao TTL da sessão server-side. */
export const SESSION_COOKIE_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

/**
 * Contexto selado no cookie (não-sensível, à prova de adulteração). **Não é
 * autoridade**: `requireAuth` deriva a org da sessão no DB, nunca deste cookie.
 * `activeOrgId` é display/seleção — QUALQUER uso futuro (org-switcher) DEVE
 * re-validar membership (`resolveBusinessScope`) antes de agir na org. Mecanismo
 * inerte hoje (só é escrito); ligado quando o org-switcher chegar (1b+).
 */
export interface SessionContextCookie {
  readonly activeOrgId: string | null;
}

/**
 * Opções padrão dos cookies de sessão: `httpOnly` (JS não lê), `sameSite=lax`
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

/** Sela o contexto da sessão (AES via iron-session). `password` = `SESSION_SECRET` (≥32). */
export function sealContext(data: SessionContextCookie, password: string): Promise<string> {
  return sealData(data, { password, ttl: SESSION_COOKIE_MAX_AGE_S });
}

/** Abre o contexto selado; devolve `null` se ausente/adulterado/expirado. */
export async function unsealContext(
  sealed: string | undefined,
  password: string,
): Promise<SessionContextCookie | null> {
  if (!sealed) return null;
  try {
    const data = await unsealData<SessionContextCookie>(sealed, { password, ttl: SESSION_COOKIE_MAX_AGE_S });
    // unseal de payload vazio devolve {} — trata como ausência.
    if (!data || typeof data.activeOrgId === "undefined") return null;
    return data;
  } catch {
    return null;
  }
}
