import { hash, verify } from "@node-rs/argon2";

/**
 * Porta de hashing de senha (borda). O core não conhece argon2; o service
 * depende só desta interface — trocar de algoritmo = trocar o adapter.
 */
export interface PasswordHasher {
  /** Deriva o hash (com salt embutido) da senha em claro. */
  hash(plain: string): Promise<string>;
  /** Confere a senha contra o hash. Nunca lança por senha errada — devolve `false`. */
  verify(hash: string, plain: string): Promise<boolean>;
}

/**
 * Adapter argon2id (via `@node-rs/argon2`, prebuilt — sem node-gyp). Parâmetros
 * default da lib (argon2id, memória/iterações seguros). A senha em claro nunca
 * é logada nem persistida.
 */
export const argon2Hasher: PasswordHasher = {
  hash(plain: string): Promise<string> {
    return hash(plain);
  },
  async verify(hashStr: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashStr, plain);
    } catch {
      // hash malformado / incompatível → trata como não-confere (nunca 500).
      return false;
    }
  },
};
