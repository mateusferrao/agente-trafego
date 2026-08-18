import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const { Pool } = pg;

export type Database = ReturnType<typeof createDb>;

/**
 * Cria o client Drizzle sobre um pool `pg`. A casca (api/worker) injeta isto
 * na composition root. O core (`@trafego/core`) nunca importa daqui.
 */
export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema, casing: "snake_case" });
}

/** Client default a partir de DATABASE_URL (conveniência p/ scripts/worker). */
export const db = createDb(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/trafego",
);
