/**
 * Runner de SQL ad-hoc p/ validação/depuração (sem depender de `psql` no PATH).
 * Uso: `pnpm db:q "select ... ;"`  — lê DATABASE_URL do .env (--env-file no script).
 */
import pg from "pg";

const sql = process.argv.slice(2).join(" ").trim();
if (!sql) {
  // eslint-disable-next-line no-console -- CLI
  console.error('uso: pnpm db:q "<SQL>"');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  // eslint-disable-next-line no-console -- CLI
  console.error("DATABASE_URL não definida (rode via `pnpm db:q`, que carrega o .env).");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
try {
  const res = await pool.query(sql);
  // eslint-disable-next-line no-console -- CLI
  console.log(Array.isArray(res.rows) ? res.rows : res);
  // eslint-disable-next-line no-console -- CLI
  console.log(`(${res.rowCount ?? 0} linha(s))`);
} finally {
  await pool.end();
}
