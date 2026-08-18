import type { Database } from "@trafego/db";
import type { LoginInput, MeOutput } from "./schema.js";

export interface AuthDeps {
  readonly db: Database;
}

export interface AuthenticatedUser {
  readonly userId: string;
  readonly orgId: string | null;
}

/**
 * Lógica de autenticação (sessão custom + argon2 atrás de AuthPort — §4/§12).
 * Verifica credencial e devolve o principal para a casca gravar na sessão.
 */
export function createAuthService(deps: AuthDeps) {
  return {
    async login(_input: LoginInput): Promise<AuthenticatedUser> {
      // TODO: buscar user por email (scoped), verificar hash argon2, resolver org default.
      void deps.db;
      throw new Error("TODO: implementar login");
    },

    async me(_userId: string): Promise<MeOutput> {
      // TODO: carregar user + org ativa.
      throw new Error("TODO: implementar me");
    },
  };
}
