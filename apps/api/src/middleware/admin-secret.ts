import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { unauthorized } from "./error-handler.js";

/** Header do segredo admin (guard da Fatia 0 até a auth real da 1a). */
export const ADMIN_SECRET_HEADER = "x-admin-secret";

/** Compara em tempo constante (hash de tamanho fixo → sem vazar tamanho). */
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Factory do guard: compara o header `x-admin-secret` com o segredo esperado
 * (tempo constante). Recebe o segredo por parâmetro (não importa env) → testável.
 */
export function makeRequireAdminSecret(expectedSecret: string) {
  return async function requireAdminSecret(request: FastifyRequest): Promise<void> {
    const provided = request.headers[ADMIN_SECRET_HEADER];
    if (typeof provided !== "string" || !secretsMatch(provided, expectedSecret)) {
      throw unauthorized("Segredo admin inválido.");
    }
  };
}
