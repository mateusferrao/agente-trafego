// Erros do Postgres reconhecidos pela casca (um lugar só — §13 reuso, sem string
// mágica). O `driver` (pg/postgres.js) expõe o SQLSTATE em `error.code`.

/** SQLSTATE de violação de UNIQUE constraint. */
export const PG_UNIQUE_VIOLATION = "23505";

/** SQLSTATE de representação textual inválida (ex: uuid malformado num param de rota). */
export const PG_INVALID_TEXT_REPRESENTATION = "22P02";

function hasPgCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

/** Violação de UNIQUE constraint (ex: corrida de insert com índice único). */
export function isUniqueViolation(error: unknown): boolean {
  return hasPgCode(error, PG_UNIQUE_VIOLATION);
}

/**
 * Representação textual inválida (SQLSTATE 22P02) — ex: um `:id` de rota que não é um
 * uuid chega ao Postgres e o driver lança. É erro de CLIENTE (link quebrado/desatualizado),
 * não bug de servidor: a casca traduz p/ resposta amigável em vez de 500 genérico.
 */
export function isInvalidTextRepresentation(error: unknown): boolean {
  return hasPgCode(error, PG_INVALID_TEXT_REPRESENTATION);
}
