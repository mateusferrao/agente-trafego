// Erros do Postgres reconhecidos pela casca (um lugar só — §13 reuso, sem string
// mágica). O `driver` (pg/postgres.js) expõe o SQLSTATE em `error.code`.

/** SQLSTATE de violação de UNIQUE constraint. */
export const PG_UNIQUE_VIOLATION = "23505";

/** Violação de UNIQUE constraint (ex: corrida de insert com índice único). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
